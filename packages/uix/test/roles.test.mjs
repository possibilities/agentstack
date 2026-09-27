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
