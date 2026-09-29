import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { extname } from "node:path";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.includes("/lib/stack/") && specifier.startsWith("./") && !extname(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const roles = await import("../lib/stack/roles.ts");

const fragment = (id, fields = {}) => ({ id, categoryId: "c", title: id.toUpperCase(), description: "", body: `${id} body`, enabled: true, createdAt: null, updatedAt: null, ...fields });
const category = (id, fragments, fields = {}) => ({ id, title: id, description: "", enabled: true, createdAt: null, updatedAt: null, fragments, ...fields });

test("fragment state names why text does or does not reach a launch", () => {
  assert.equal(roles.fragmentState(fragment("a"), { enabled: true }), "renders");
  assert.equal(roles.fragmentState(fragment("a", { enabled: false }), { enabled: true }), "off");
  assert.equal(roles.fragmentState(fragment("a", { body: " \n " }), { enabled: true }), "empty");
  // A disabled category outranks the fragment's own state.
  assert.equal(roles.fragmentState(fragment("a", { enabled: false }), { enabled: false }), "category-off");
  const role = { categories: [category("on", [fragment("a"), fragment("b", { body: "" })]), category("off", [fragment("c")], { enabled: false })] };
  assert.deepEqual(roles.roleCounts(role), { categories: 2, fragments: 3, rendering: 1 });
  assert.equal(roles.findFragment(role, "c").category.id, "off");
  assert.equal(roles.findFragment(role, "c").index, 0);
  assert.equal(roles.findFragment(role, "zzz"), null);
  assert.equal(roles.findCategory(role, "off").index, 1);
});

test("search keeps a matching category whole and otherwise filters fragments by every word", () => {
  const categories = [
    category("Planning", [fragment("a", { title: "Scope", body: "Read the brief first" }), fragment("b", { title: "Tests", description: "run them" })]),
    category("Style", [fragment("c", { title: "Tone", body: "Plain words" })], { description: "writing rules" }),
  ];
  assert.equal(roles.filterRole(categories, "  ").length, 2);
  assert.deepEqual(roles.filterRole(categories, "brief").map(({ category, fragments }) => [category.id, fragments.map((item) => item.id)]), [["Planning", ["a"]]]);
  assert.deepEqual(roles.filterRole(categories, "WRITING").map(({ fragments }) => fragments.map((item) => item.id)), [["c"]]);
  assert.deepEqual(roles.filterRole(categories, "planning run").map(({ fragments }) => fragments.map((item) => item.id)), [["b"]]);
  assert.deepEqual(roles.filterRole(categories, "nothing"), []);
});

test("move helpers produce the API's index and exact permutation", () => {
  const list = category("c", [fragment("a"), fragment("b"), fragment("c")]);
  assert.equal(roles.moveIndex(list, "c", "a"), 0);
  assert.equal(roles.moveIndex(list, "a", null), 2);
  assert.equal(roles.moveIndex(list, "a", "c"), 1);
  assert.equal(roles.moveIndex(category("other", [fragment("x")]), "a", "x"), 0);
  assert.equal(roles.moveIndex(list, "a", "missing"), 2);
  const categories = [{ id: "1" }, { id: "2" }, { id: "3" }];
  assert.deepEqual(roles.categoryOrder(categories, "3", "1"), ["3", "1", "2"]);
  assert.deepEqual(roles.categoryOrder(categories, "1", null), ["2", "3", "1"]);
  assert.deepEqual(roles.categoryOrder(categories, "1", "3"), ["2", "1", "3"]);
  assert.deepEqual(roles.addedIds([{ id: "a" }], [{ id: "a" }, { id: "b" }]), ["b"]);
  assert.equal(roles.copyTitle("x".repeat(200)).length, 200);
});

test("drafts keep only real edits, follow unrelated saves, and surface conflicting ones", () => {
  const saved = { title: "Rule", description: "", body: "Old" };
  let draft = roles.editDraft(roles.emptyDraft, "body", "New", saved);
  assert.deepEqual(draft, { base: { body: "Old" }, values: { body: "New" } });
  assert.equal(roles.draftDirty(draft, saved), true);
  // Typing back to the starting text clears the edit.
  assert.deepEqual(roles.editDraft(draft, "body", "Old", saved), { base: {}, values: {} });
  // Someone else renames it: the untouched title follows, the body edit stays and is not in conflict.
  const renamed = { ...saved, title: "Renamed" };
  assert.deepEqual(roles.draftConflicts(draft, renamed), []);
  assert.deepEqual(roles.draftChanges(draft, renamed), { body: "New" });
  // Someone else changes the body too: that is a conflict.
  const rewritten = { ...saved, body: "Theirs" };
  assert.deepEqual(roles.draftConflicts(draft, rewritten), ["body"]);
  assert.deepEqual(roles.draftConflicts(roles.keepDraft(draft, rewritten), rewritten), []);
  assert.deepEqual(roles.draftChanges(roles.keepDraft(draft, rewritten), rewritten), { body: "New" });
  assert.deepEqual(roles.yieldDraft(draft, rewritten), { base: {}, values: {} });
  // A save that already landed leaves nothing to write.
  assert.deepEqual(roles.draftChanges(draft, { ...saved, body: "New" }), {});
  draft = roles.editDraft(draft, "title", "Retitled", saved);
  assert.deepEqual(Object.keys(roles.yieldDraft(draft, rewritten).values), ["title"]);
  assert.deepEqual(roles.fragmentText(fragment("a")), { title: "A", description: "", body: "a body" });
  assert.deepEqual(roles.categoryText(category("k", [])), { title: "k", description: "" });
});

test("preview pieces label spans from the Role and sizes fall back for an older API", () => {
  const role = { categories: [category("c", [fragment("a"), fragment("b")])] };
  const preview = { roleId: "r1", revision: 4, rendered: "a body\n\nb body", bytes: 14, limitBytes: 262144,
    segments: [{ categoryId: "c", fragmentId: "a", start: 0, end: 6 }, { categoryId: "c", fragmentId: "gone", start: 8, end: 14 }] };
  assert.deepEqual(roles.previewPieces(preview, role), [
    { fragmentId: "a", categoryId: "c", text: "a body", title: "A" },
    { fragmentId: "gone", categoryId: "c", text: "b body", title: null },
  ]);
  // A Roles API older than this UI reports neither spans nor size.
  assert.equal(roles.previewPieces({ revision: 1, rendered: "Whole" }, role), null);
  assert.equal(roles.previewBytes({ revision: 1, rendered: "Sé" }), 3);
  assert.equal(roles.previewBytes(preview), 14);
  assert.equal(roles.formatBytes(812), "812 B");
  assert.equal(roles.formatBytes(14_540), "14 KB");
  assert.equal(roles.formatBytes(5_000), "4.9 KB");
  assert.equal(roles.formatCount(3_640), "3.6k");
  assert.equal(roles.approxTokens(roles.utf8Bytes("é")), 1);
});

const role = (id, name, revision = 1) => ({ id, name, description: "", revision, createdAt: null, updatedAt: null });
const catalog = (defaultRoleId, roleList, revision = 1, workerDefaultRoleId = defaultRoleId) => ({ revision, defaultRoleId, workerDefaultRoleId, roles: roleList });

test("a launch is classified by Role identity and revision against the default, never by revision alone", () => {
  const two = catalog("A", [role("A", "Default", 5), role("B", "Researcher", 5)]);
  const at = (roleId, roleRevision) => roles.classifyLaunch({ roleId, roleRevision }, two);
  assert.equal(at("A", 5).state, "current");
  assert.equal(at("A", 3).state, "older");
  // Equal revision numbers across Roles are unrelated: the other Role is not "current" at r5.
  assert.deepEqual(at("B", 5), { state: "other", roleId: "B", roleRevision: 5, name: "Researcher" });
  // A launch newer than the catalog's read means the catalog is a step behind, which is not "older".
  assert.equal(at("A", 6).state, "current");
  // A deleted Role is still named as one, with the revision it launched at.
  const gone = at("Z", 2);
  assert.deepEqual(gone, { state: "other", roleId: "Z", roleRevision: 2, name: null });
  assert.equal(roles.launchLabel(gone), "Deleted role r2");
  // Legacy launches have no Role ID: unknown, even at the default's revision. Nothing has launched before a revision exists.
  assert.equal(at(null, 5).state, "unknown");
  assert.equal(roles.launchLabel(at(null, 5)), "Unknown role r5");
  assert.equal(at(null, null), null);
  // A record from an older API that omits the ID is as anonymous as a null one.
  assert.equal(roles.classifyLaunch({ roleRevision: 5 }, two).state, "unknown");
  assert.equal(roles.classifyLaunch({ roleId: "A", roleRevision: 5 }, null), null);

  // Making B the default turns A's running Bot from "current" into "other", and B's into "current": neither changed.
  const swapped = catalog("B", two.roles, 2);
  assert.equal(roles.classifyLaunch({ roleId: "A", roleRevision: 5 }, swapped).state, "other");
  assert.equal(roles.classifyLaunch({ roleId: "B", roleRevision: 5 }, swapped).state, "current");
  const defaultRole = swapped.roles[1];
  const hint = roles.launchHint(roles.classifyLaunch({ roleId: "A", roleRevision: 5 }, swapped), defaultRole, "bot");
  assert.equal(hint, "Launched with Default r5 · restart to use Researcher");
  assert.doesNotMatch(hint, /changed|updated/);
  assert.equal(roles.launchHint(at("A", 3), two.roles[0], "bot"), "Launched with Default r3 · restart to use r5");
  assert.equal(roles.launchHint(at("A", 5), two.roles[0], "bot"), null);
  // A Worker never restarts into a new default; only new Workers use it.
  assert.equal(roles.launchHint(at("B", 5), two.roles[0], "worker"), "Started with Researcher r5 · new Workers use Default");

  const bot = (id, state, roleId, roleRevision) => ({ id, state, roleId, roleRevision });
  const worker = (phase, roleId, roleRevision) => ({ phase, roleId, roleRevision });
  const launches = roles.roleLaunches(
    [bot("bot-1", "running", "A", 5), bot("bot-2", "running", "B", 5), bot("bot-3", "stopped", "A", 1), bot("bot-4", "running", null, null), bot("bot-5", "running", null, 2)],
    [worker("idle", "A", 5), worker("running", "A", 3), worker("closed", "A", 1), worker("idle", null, null), worker("idle", "B", 5), worker("failed", "B", 1), worker("idle", null, 4)], two);
  assert.deepEqual(launches.bots.map(({ bot, launch }) => [bot.id, launch.state]), [["bot-1", "current"], ["bot-2", "other"], ["bot-5", "unknown"]]);
  assert.deepEqual(launches.workers, { current: 1, older: 1, other: 1, unknown: 1, total: 4 });
  const split = catalog("A", two.roles, 3, "B");
  assert.equal(roles.classifyLaunch({ roleId: "A", roleRevision: 5 }, split, "bot").state, "current");
  assert.equal(roles.classifyLaunch({ roleId: "B", roleRevision: 5 }, split, "worker").state, "current");
  assert.equal(roles.classifyLaunch({ roleId: "A", roleRevision: 5 }, split, "worker").state, "other");
});

test("a Role response is fenced by Role ID first and revision second", () => {
  const held = { roleId: "B", revision: 2 };
  // Role A's response never replaces Role B's, however new it is.
  assert.equal(roles.acceptRoleRead("B", held, { roleId: "A", revision: 99 }), false);
  assert.equal(roles.acceptRoleRead("B", null, { roleId: "A", revision: 1 }), false);
  // A read for a selection the page has left is dropped even with nothing held.
  assert.equal(roles.acceptRoleRead(null, null, { roleId: "A", revision: 1 }), false);
  // The same Role never rolls back, but an equal revision refreshes (manifest changes do not advance revisions).
  assert.equal(roles.acceptRoleRead("B", held, { roleId: "B", revision: 1 }), false);
  assert.equal(roles.acceptRoleRead("B", held, { roleId: "B", revision: 2 }), true);
  assert.equal(roles.acceptRoleRead("B", held, { roleId: "B", revision: 3 }), true);
  assert.equal(roles.acceptRoleRead("B", null, { roleId: "B", revision: 0 }), true);
  // An editor snapshot names its Role `id`; every other read names it `roleId`.
  assert.deepEqual(roles.roleReadOf({ id: "A", revision: 3, name: "x" }), { roleId: "A", revision: 3 });
  assert.deepEqual(roles.roleReadOf({ roleId: "A", revision: 3 }), { roleId: "A", revision: 3 });
  // The catalog is fenced by its own revision, which Role revisions never touch.
  assert.equal(roles.acceptCatalog({ revision: 7 }, { revision: 6 }), false);
  assert.equal(roles.acceptCatalog({ revision: 7 }, { revision: 7 }), true);
  assert.equal(roles.acceptCatalog(null, { revision: 0 }), true);
});

test("drafts stay with the Role they were made for", () => {
  const draft = (text) => ({ base: { body: "" }, values: { body: text } });
  let all = {
    [roles.draftKey("A", "fragment:f1")]: draft("for A"),
    [roles.draftKey("B", "fragment:f1")]: draft("for B"),
    [roles.draftKey("B", "new-category")]: draft("more B"),
    [roles.draftKey("B", "new-role")]: draft("catalog"),
  };
  // A Role not yet created belongs to the catalog, whichever Role is selected.
  assert.equal(roles.draftKey("B", "new-role"), "catalog:new-role");
  assert.deepEqual(Object.keys(all).sort(), ["A:fragment:f1", "B:fragment:f1", "B:new-category", "catalog:new-role"]);
  // Each Role's windows see only its own drafts (plus the catalog's), under the keys their editors use.
  assert.deepEqual(roles.roleScoped(all, "A"), { "fragment:f1": draft("for A"), "new-role": draft("catalog") });
  assert.deepEqual(Object.keys(roles.roleScoped(all, "B")).sort(), ["fragment:f1", "new-category", "new-role"]);
  assert.equal(roles.roleScoped(all, "B")["fragment:f1"].values.body, "for B");
  // Selecting the other Role, or switching the default, changes what is shown but retargets nothing; switching back restores it.
  assert.equal(roles.roleScoped(all, "A")["fragment:f1"].values.body, "for A");
  assert.deepEqual(roles.roleScoped(all, null), { "new-role": draft("catalog") });
  assert.deepEqual([...roles.scopedRoles(all)].sort(), ["A", "B"]);
  assert.deepEqual(roles.roleEntries(all, "B").map(([key]) => key).sort(), ["fragment:f1", "new-category"]);
  // Discarding one Role's drafts leaves the others.
  all = Object.fromEntries(Object.entries(all).filter(([key]) => !key.startsWith("B:")));
  assert.deepEqual([...roles.scopedRoles(all)], ["A"]);
});

test("the selection follows the default until a Role is chosen, and a deleted Role is kept only while it holds edits", () => {
  const cat = catalog("A", [role("A", "Default"), role("B", "Researcher")]);
  const none = new Set();
  // Nothing changes before the catalog loads.
  assert.deepEqual(roles.resolveSelection("B", null, none), { roleId: "B", deleted: false, fellBack: null });
  // With no valid selection, edit the default.
  assert.deepEqual(roles.resolveSelection(null, cat, none), { roleId: "A", deleted: false, fellBack: null });
  assert.deepEqual(roles.resolveSelection("B", cat, none), { roleId: "B", deleted: false, fellBack: null });
  // A selection that is not the default stays put; the default moving does not pull it.
  assert.deepEqual(roles.resolveSelection("B", catalog("B", cat.roles, 2), none), { roleId: "B", deleted: false, fellBack: null });
  // The selected Role was deleted elsewhere: without drafts, fall back to the default and say which Role went.
  assert.deepEqual(roles.resolveSelection("Z", cat, none), { roleId: "A", deleted: false, fellBack: "Z" });
  // With unsaved drafts, keep the selection on the missing ID so nothing is silently discarded or applied elsewhere.
  assert.deepEqual(roles.resolveSelection("Z", cat, new Set(["Z"])), { roleId: "Z", deleted: true, fellBack: null });
  // Another Role's drafts do not keep it.
  assert.deepEqual(roles.resolveSelection("Z", cat, new Set(["B"])), { roleId: "A", deleted: false, fellBack: "Z" });
  // An empty catalog has no default to fall back to.
  assert.deepEqual(roles.resolveSelection("Z", catalog(null, []), none), { roleId: null, deleted: false, fellBack: "Z" });
  assert.equal(roles.roleLabel(role("A", "Default"), true), "Default · default");
  assert.equal(roles.roleLabel(role("B", "Researcher"), false), "Researcher");
  assert.equal(roles.roleLabel(null, false), null);
});

test("Role names mirror the API's limits and its ASCII-case uniqueness", () => {
  const cat = catalog("A", [role("A", "Researcher"), role("B", "Écrivain")]);
  assert.equal(roles.roleNameIssue("  ", cat), "A name is required");
  assert.equal(roles.roleNameIssue("Planner", cat), null);
  assert.match(roles.roleNameIssue("researcher", cat), /already uses/);
  assert.match(roles.roleNameIssue(" RESEARCHER ", cat), /already uses/);
  // SQLite's NOCASE folds ASCII only, so a non-ASCII case difference is a different name to the API.
  assert.equal(roles.roleNameIssue("écrivain", cat), null);
  // Renaming a Role to its own name in another case is fine.
  assert.equal(roles.roleNameIssue("RESEARCHER", cat, "A"), null);
  assert.match(roles.roleNameIssue("x".repeat(201), cat), /200/);
  assert.equal(roles.roleNameIssue("x".repeat(200), cat), null);
  assert.equal(roles.roleErrorText("UNIQUE constraint failed: roles.name"), "Another Role already uses this name; letter case is ignored");
  assert.equal(roles.roleErrorText("stale role revision: expected 1, current 2"), "stale role revision: expected 1, current 2");
});

test("an external MCP server may not take an internal name, on or off", () => {
  const internal = { roleId: "A", revision: 3, servers: [{ name: "roles", enabled: false }, { name: "bots", enabled: true }] };
  // The launch preview lists the same servers; a name only one of them knows still counts.
  const launch = { internalMcpServers: [{ name: "bots", enabled: true }, { name: "notify", enabled: false }] };
  const names = roles.internalNames(internal, launch);
  assert.deepEqual([...names].sort(), ["bots", "notify", "roles"]);
  assert.equal(roles.internalCollision("roles", names), true, "switched off, still reserved");
  assert.equal(roles.internalCollision("NOTIFY", names), true);
  assert.equal(roles.internalCollision("scrape", names), false);
  assert.deepEqual(roles.internalNames(null, null), []);
  assert.deepEqual(roles.internalNames(null, launch), ["bots", "notify"]);
  assert.deepEqual(roles.internalCounts(internal.servers), { on: 1, total: 2 });
  assert.deepEqual(roles.internalCounts([]), { on: 0, total: 0 });
});

test("MCP forms round-trip a definition, omit blank optional fields and render the launch's TOML", () => {
  const http = { type: "http", url: "https://mcp.example.test/tools", bearerTokenEnvVar: "ROLE_TOKEN" };
  const form = roles.toMcpForm(http);
  assert.deepEqual(roles.fromMcpForm(form), { definition: http, issues: [] });
  // Switching transport keeps the other transport's fields for switching back.
  assert.equal(roles.draftMcpForm(JSON.stringify({ ...form, type: "stdio" })).url, http.url);
  // Byte-for-byte what role_launch_preview reports for the same server (packages/roles/test/socket.test.ts).
  assert.equal(roles.mcpToml("remote", http), '[mcp_servers.remote]\nurl = "https://mcp.example.test/tools"\nbearer_token_env_var = "ROLE_TOKEN"\nenabled = true\n');
  const stdio = roles.fromMcpForm({ ...roles.emptyMcpForm, type: "stdio", command: " /usr/bin/env ", args: ["true", ""], env: [["MODE", "role"], ["", ""]], envVars: [" HOME ", "HOME"] });
  assert.deepEqual(stdio.definition, { type: "stdio", command: "/usr/bin/env", args: ["true", ""], env: { MODE: "role" }, envVars: ["HOME"] });
  assert.equal(roles.mcpToml("local", stdio.definition), '[mcp_servers.local]\ncommand = "/usr/bin/env"\nargs = ["true", ""]\nenv = { "MODE" = "role" }\nenv_vars = ["HOME"]\nenabled = true\n');
  assert.equal(roles.mcpLiterals(stdio.definition), 1);
  assert.deepEqual(roles.fromMcpForm({ ...roles.emptyMcpForm, url: "https://user:pw@example.test/#x", httpHeaders: [["X-A", "1"], ["x-a", "2"]], envHttpHeaders: [["X-B", "not a var"]] }).issues, [
    "The URL must be HTTP(S) without credentials or a #fragment", "Headers: “x-a” appears twice", "Environment headers: “not a var” is not an environment variable name",
  ]);
  assert.equal(roles.fromMcpForm({ ...roles.emptyMcpForm, type: "stdio" }).definition, null);
  // A saved definition and its unedited form text compare equal, so opening a record never marks it dirty.
  assert.equal(roles.mcpText({ name: "remote", description: "", definition: http }).definition, JSON.stringify(roles.toMcpForm(http)));
});

test("a pasted command line splits into words without shell expansion", () => {
  assert.deepEqual(roles.splitCommandLine(`node "my server.js" --flag='a b' $HOME\\ x ""`), ["node", "my server.js", "--flag=a b", "$HOME x", ""]);
  assert.deepEqual(roles.splitCommandLine("   "), []);
});

test("skill files mirror the API's path and size rules and survive a base64 round trip", () => {
  const text = roles.textFile("scripts/check.sh", "exit 0\n");
  assert.equal(text.contentBase64, Buffer.from("exit 0\n").toString("base64"));
  assert.equal(roles.fileText(text), "exit 0\n");
  assert.equal(roles.base64Bytes(text.contentBase64), 7);
  assert.equal(roles.fileText({ path: "a.bin", contentBase64: Buffer.from([0xff, 0x00, 0x01]).toString("base64") }), null);
  const bytes = new Uint8Array(100_000).map((_, index) => index % 256);
  assert.deepEqual(roles.decodeBase64(roles.encodeBase64(bytes)), bytes);
  assert.equal(roles.encodeBase64(bytes), Buffer.from(bytes).toString("base64"));
  assert.deepEqual(roles.skillFileIssues([text]), []);
  assert.deepEqual(roles.skillFileIssues([{ path: "../escape", contentBase64: "" }, { path: "SKILL.md", contentBase64: "" }, { path: "a", contentBase64: "" }, { path: "a/b", contentBase64: "" }, { path: "A", contentBase64: "" }]), [
    "../escape needs a relative path of letters, digits, “.”, “_” and “-”", "SKILL.md is generated from the name, description and body", "A appears twice", "a is both a file and a folder",
  ]);
  assert.equal(roles.safeFilePath("My Notes (v2).md"), "My-Notes-v2-.md");
  assert.equal(roles.safeFilePath("SKILL.md"), "file");
  assert.equal(roles.skillBytes({ body: "é", files: [text] }), 9);
});

test("resource names follow the launch pattern and duplicates take the next free name", () => {
  assert.equal(roles.nameIssue("review", ["draft"]), null);
  assert.match(roles.nameIssue("Review", []), /lowercase/);
  assert.match(roles.nameIssue("review", ["REVIEW"]), /already uses/);
  assert.equal(roles.uniqueName("review", ["review"]), "review-copy");
  assert.equal(roles.uniqueName("review", ["review-copy"]), "review-copy-2");
  assert.equal(roles.uniqueName("review", ["review-copy", "review-copy-2"]), "review-copy-3");
  assert.equal(roles.uniqueName("a".repeat(32), []).length, 32);
  assert.deepEqual(roles.resourceOrder([{ id: "a" }, { id: "b" }, { id: "c" }], "c", "a"), ["c", "a", "b"]);
});

test("a trusted project lists the Bots whose working directory the launch preview matched", () => {
  const launch = { cwds: [{ cwd: "/work/repo/src", path: "/work/repo/src", trustedProjectIds: ["p1"] }, { cwd: "/elsewhere", path: "/elsewhere", trustedProjectIds: [] }] };
  const bots = [{ id: "bot-1", cwd: "/work/repo/src" }, { id: "bot-2", cwd: "/elsewhere" }];
  assert.deepEqual(roles.projectBots(launch, "p1", bots).map((bot) => bot.id), ["bot-1"]);
  assert.deepEqual(roles.projectBots(null, "p1", bots), []);
});
