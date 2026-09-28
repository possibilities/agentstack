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

test("preview pieces label spans from the Role and launches compare revisions", () => {
  const role = { categories: [category("c", [fragment("a"), fragment("b")])] };
  const preview = { revision: 4, rendered: "a body\n\nb body", bytes: 14, limitBytes: 262144,
    segments: [{ categoryId: "c", fragmentId: "a", start: 0, end: 6 }, { categoryId: "c", fragmentId: "gone", start: 8, end: 14 }] };
  assert.deepEqual(roles.previewPieces(preview, role), [
    { fragmentId: "a", categoryId: "c", text: "a body", title: "A" },
    { fragmentId: "gone", categoryId: "c", text: "b body", title: null },
  ]);
  // A Roles API older than this UI reports neither spans nor size.
  assert.equal(roles.previewPieces({ revision: 1, rendered: "Whole" }, role), null);
  assert.equal(roles.previewBytes({ revision: 1, rendered: "Sé" }), 3);
  assert.equal(roles.previewBytes(preview), 14);
  const bot = (id, state, roleRevision) => ({ id, state, roleRevision });
  const worker = (phase, roleRevision) => ({ phase, roleRevision });
  const launches = roles.roleLaunches([bot("bot-1", "running", 4), bot("bot-2", "running", 2), bot("bot-3", "stopped", 1), bot("bot-4", "running", null)],
    [worker("idle", 4), worker("running", 3), worker("closed", 1), worker("idle", null)], 4);
  assert.deepEqual(launches.bots.map(({ bot, current }) => [bot.id, current]), [["bot-1", true], ["bot-2", false]]);
  assert.deepEqual(launches.workers, { current: 1, behind: 1 });
  assert.equal(roles.formatBytes(812), "812 B");
  assert.equal(roles.formatBytes(14_540), "14 KB");
  assert.equal(roles.formatBytes(5_000), "4.9 KB");
  assert.equal(roles.formatCount(3_640), "3.6k");
  assert.equal(roles.approxTokens(roles.utf8Bytes("é")), 1);
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
