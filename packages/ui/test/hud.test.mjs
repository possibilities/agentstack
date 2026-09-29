import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import test from "node:test";

// Load the pure stack modules directly without a Next build. Their
// bundler-style imports need extensions when loaded by Node.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.includes("/lib/stack/") && specifier.startsWith("./") && !extname(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const { hudFailure, loadTree, stepOrder, siblingsOf, treeWindow } = await import("../lib/stack/hud.ts");
// The real HUD store supplies tree, snapshot and conflict semantics; nothing here restates them.
const { HudStore } = await import("../../hud/dist/src/store.js");
const { change } = await import("../../hud/dist/src/schema.js");

const operator = { kind: "operator" };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "stack-ui-hud-"));
  const store = new HudStore(root);
  const apply = (...changes) => store.apply(randomUUID(), changes.map((value) => change.parse(value)), operator);
  const create = (title, extra = {}) => { const id = randomUUID(); apply({ action: "create", id, title, objective: `${title} objective`, ...extra }); return id; };
  const tree = (args) => store.tree({ offset: 0, limit: 100, ...args });
  return { store, apply, create, tree, close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("tree reads restart after a concurrent change instead of combining generations", async () => {
  const hud = fixture();
  try {
    for (let index = 0; index < 250; index++) hud.create(`Item ${index}`, { order: index });
    let pages = 0;
    const call = async (_name, args) => {
      const page = hud.store.tree(args);
      // An agent edits between the first and second page of the first read only.
      if (++pages === 1) hud.create("Concurrent");
      return page;
    };
    const tree = await loadTree(call, 1_000);
    assert.equal(tree.complete, true);
    assert.equal(tree.rows.length, 251);
    assert.equal(tree.total, 251);
    assert.ok(tree.rows.some((row) => row.item.title === "Concurrent"), "the restarted read includes the change");
    assert.equal(new Set(tree.rows.map((row) => row.item.id)).size, 251, "no row from an earlier generation is repeated");

    const partial = await loadTree((_name, args) => Promise.resolve(hud.store.tree(args)), 100);
    assert.equal(partial.complete, false, "a budget below the total reports an incomplete tree");
    assert.equal(partial.rows.length, 200);

    // A hierarchy that changes on every page is an error, never a partial mix.
    await assert.rejects(loadTree(async (_name, args) => { const page = hud.store.tree(args); hud.create("Churn"); return page; }, 1_000), /work_snapshot_changed/);
  } finally { hud.close(); }
});

test("filters keep matches under their real ancestors and say what they hid", () => {
  const hud = fixture();
  try {
    const done = hud.create("Shipped epic", { state: "active" });
    const cancelledChild = hud.create("Dropped idea", { parentId: done, state: "cancelled" });
    const closedChild = hud.create("Old task", { parentId: done, state: "completed" });
    hud.apply({ action: "update", id: done, expectedRevision: 1, patch: { state: "completed" } });
    // Cancelling a parent never cascades, so it can keep open children.
    const epic = hud.create("Cancelled epic", { state: "cancelled" });
    const live = hud.create("Still open", { parentId: epic, state: "active" });
    const deep = hud.create("Needs review deep", { parentId: live, state: "review", attention: "human" });
    const { rows } = hud.tree();

    const open = treeWindow(rows, { view: "open", query: "" }, new Set(), null);
    const shown = new Map(open.rows.map((entry) => [entry.row.item.id, entry]));
    assert.equal(shown.get(epic)?.context, true, "a closed parent of open work stays as context");
    assert.equal(shown.get(live)?.row.item.parentId, epic, "the open child keeps its real parent");
    assert.equal(shown.has(done), false);
    assert.equal(open.hiddenClosed, 3, "the completed epic, its completed and its cancelled child are counted as hidden");
    assert.ok(!shown.has(closedChild) && !shown.has(cancelledChild));

    const search = treeWindow(rows, { view: "all", query: "review deep" }, new Set(), null);
    assert.deepEqual(search.rows.map((entry) => [entry.row.item.id, entry.context]), [[epic, true], [live, true], [deep, false]]);

    const collapsed = treeWindow(rows, { view: "all", query: "" }, new Set([epic]), null);
    assert.ok(!collapsed.rows.some((entry) => entry.row.item.id === live));
    assert.equal(collapsed.hiddenCollapsed, 2);

    const subtree = treeWindow(rows, { view: "attention", query: "" }, new Set(), live);
    assert.deepEqual(subtree.rows.map((entry) => entry.row.item.id), [live, deep], "a focused subtree keeps its root as context");
  } finally { hud.close(); }
});

test("moving among siblings lands exactly one place over, even when their orders tie", () => {
  const hud = fixture();
  try {
    const parent = hud.create("Parent");
    const [a, b, c] = ["A", "B", "C"].map((title) => hud.create(title, { parentId: parent }));
    const order = () => siblingsOf(parent, hud.tree().rows).map((item) => item.title);
    const move = (id, direction) => {
      const rows = hud.tree().rows;
      const item = rows.find((row) => row.item.id === id).item;
      const edits = stepOrder(item, siblingsOf(parent, rows), direction);
      hud.apply(...edits.map(({ item: sibling, order: value }) => ({ action: "update", id: sibling.id, expectedRevision: sibling.revision, patch: { order: value } })));
      return edits.length;
    };
    assert.deepEqual(order(), ["A", "B", "C"]);
    assert.ok(move(c, -1) > 1, "tied orders need renumbering");
    assert.deepEqual(order(), ["A", "C", "B"]);
    assert.equal(move(a, 1), 1, "distinct neighbors need a single edit");
    assert.deepEqual(order(), ["C", "A", "B"]);
    assert.equal(stepOrder(hud.tree().rows.find((row) => row.item.id === b).item, siblingsOf(parent, hud.tree().rows), 1), null, "the last sibling can't move down");
  } finally { hud.close(); }
});

test("failures separate revision conflicts, reused request IDs and unknown transport outcomes", () => {
  const hud = fixture();
  try {
    const id = hud.create("Edited twice");
    hud.apply({ action: "update", id, expectedRevision: 1, patch: { summary: "theirs" } });
    const stale = (() => { try { hud.apply({ action: "update", id, expectedRevision: 1, patch: { summary: "mine" } }); } catch (error) { return error; } })();
    assert.equal(hudFailure(stale).kind, "conflict");
    const requestId = randomUUID();
    hud.store.apply(requestId, [change.parse({ action: "update", id, expectedRevision: 2, patch: { summary: "one" } })], operator);
    const reused = (() => { try { hud.store.apply(requestId, [change.parse({ action: "update", id, expectedRevision: 3, patch: { summary: "two" } })], operator); } catch (error) { return error; } })();
    assert.deepEqual([hudFailure(reused).kind, hudFailure(reused).code], ["refused", "work_request_conflict"]);
    // Transport failures come from the page's channel, not the API.
    assert.equal(hudFailure(new Error("connection closed")).kind, "uncertain");
    assert.equal(hudFailure(new Error("hud WebSocket is not connected")).kind, "unsent");
  } finally { hud.close(); }
});
