import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CapabilityStore, renderInstructions } from "../src/store.js";
import { materializeBundle, removeBundle } from "../src/bundle.js";

test("categories and fragments are durable, ordered, and rendered without human metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-capabilities-"));
  let store = new CapabilityStore(root);
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
    assert.throws(() => store.updateFragment(state.revision - 1, gamma, { body: "stale" }), /stale capabilities revision/);
    assert.equal(store.snapshot().revision, state.revision);
    store.close();
    store = new CapabilityStore(root);
    assert.deepEqual(store.snapshot(), state);
    state = store.deleteFragment(state.revision, gamma);
    state = store.deleteFragment(state.revision, beta);
    state = store.deleteCategory(state.revision, tools);
    assert.equal(state.categories.length, 1);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("a bundle snapshots instructions and MCP configuration without argv content", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-capability-bundle-"));
  const store = new CapabilityStore(root);
  try {
    let state = store.createCategory(0, "Default");
    state = store.createFragment(state.revision, state.categories[0]!.id, "Prompt", "Do useful work.", "not rendered");
    const first = await materializeBundle(root, "bot-1", state, { auth: "http://127.0.0.1:8743/mcp/auth" });
    assert.equal(await readFile(join(first, "SYSTEM_APPEND.md"), "utf8"), "Do useful work.");
    assert.match(await readFile(join(first, "config.toml"), "utf8"), /\[mcp_servers.auth\]/);
    state = store.updateFragment(state.revision, state.categories[0]!.fragments[0]!.id, { body: "Changed." });
    const second = await materializeBundle(root, "bot-1", state, {});
    assert.equal(await readFile(join(first, "SYSTEM_APPEND.md"), "utf8"), "Do useful work.");
    assert.equal(await readFile(join(second, "SYSTEM_APPEND.md"), "utf8"), "Changed.");
    await assert.rejects(removeBundle(root, "bot-2", first), /unrecognized/);
    await removeBundle(root, "bot-1", first);
    await removeBundle(root, "bot-1", second);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("an oversized assembled prompt is rejected before committing an edit", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-capability-limit-"));
  const store = new CapabilityStore(root);
  try {
    let state = store.createCategory(0, "Large");
    const categoryId = state.categories[0]!.id;
    state = store.createFragment(state.revision, categoryId, "First", "a".repeat(200_000));
    assert.throws(() => store.createFragment(state.revision, categoryId, "Too much", "b".repeat(70_000)), /exceed 262144 bytes/);
    assert.deepEqual(store.snapshot(), state);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
