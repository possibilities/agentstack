import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { extname } from "node:path";
import test from "node:test";

registerHooks({ resolve(specifier, context, next) {
  return next(context.parentURL?.includes("/lib/stack/") && specifier.startsWith("./") && !extname(specifier) ? `${specifier}.ts` : specifier, context);
} });
const { botHandoff, browseCallError, browseLocalReason, controllerKey, deleteBlock, groupHandoffs, groupProfiles, heldBy, intentFor, loadIntent, saveIntent } = await import("../lib/stack/browse.ts");
const { ViewerWindowStore, primaryViewer } = await import("../lib/stack/browse-viewers.ts");

const handoff = (patch = {}) => ({ id: "h1", profileId: "p1", botId: "bot-1", threadId: "t", instance: "i", requestId: "r", targetId: null, targetStatus: "unspecified", message: "Sign in to GitHub",
  state: "awaiting_human", outcome: null, note: null, revision: 3, createdAt: "2026-09-28T10:00:00Z", resolvedAt: null, issue: null, quiesced: true, ...patch });
const profile = (patch = {}) => ({ id: "p1", botId: "bot-1", label: "default", default: true, createdAt: "2026-09-28T09:00:00Z", state: "ready", error: null, observedAt: null, cdpUrl: null, observation: null, ...patch });
const controller = (patch = {}) => ({ botId: "bot-1", instance: "i", session: "default", profileId: "p1", actualProfileId: "p1", targetId: null, cdpUrl: null, state: "connected", revision: 1, observedAt: null, error: null, ...patch });

function memory() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key), values };
}

test("browse is never available remotely", () => {
  assert.equal(browseLocalReason(undefined), null);
  assert.equal(browseLocalReason({ scope: "control", scopes: [] }), "Available only on the local UIX");
});

test("a timeout or dropped connection is an unknown outcome; a stale revision is its own case", () => {
  assert.deepEqual(browseCallError(new Error("socket call timed out: tools/call")), { text: "Outcome unknown: socket call timed out: tools/call", uncertain: true, stale: false });
  assert.equal(browseCallError(new Error("connection closed")).uncertain, true);
  assert.equal(browseCallError(new Error("stale handoff revision")).stale, true);
  assert.deepEqual(browseCallError(new Error("handoff is not awaiting human control")), { text: "handoff is not awaiting human control", uncertain: false, stale: false });
});

test("unresolved handoffs group by state oldest first; resolved history is newest first", () => {
  const groups = groupHandoffs([
    handoff({ id: "late", createdAt: "2026-09-28T11:00:00Z" }),
    handoff({ id: "early", createdAt: "2026-09-28T09:00:00Z" }),
    handoff({ id: "prep", state: "preparing" }),
    handoff({ id: "mine", state: "human_controlling" }),
    handoff({ id: "old", state: "resolved", resolvedAt: "2026-09-27T10:00:00Z" }),
    handoff({ id: "new", state: "resolved", resolvedAt: "2026-09-28T12:00:00Z" }),
  ]);
  assert.deepEqual(groups.open.map((group) => [group.state, group.handoffs.map((item) => item.id)]), [["awaiting_human", ["early", "late"]], ["human_controlling", ["mine"]], ["preparing", ["prep"]]]);
  assert.deepEqual(groups.resolved.map((item) => item.id), ["new", "old"]);
});

test("holds, Bot help and deletion blocks mirror the API's rules", () => {
  const list = [handoff({ state: "resolved" }), handoff({ id: "h2", profileId: "p2", state: "human_controlling" })];
  assert.equal(heldBy("p1", list), null);
  assert.equal(heldBy("p2", list)?.id, "h2");
  assert.equal(botHandoff("bot-1", list)?.id, "h2");
  assert.equal(botHandoff("bot-1", [handoff({ state: "preparing" })]), null);
  assert.equal(deleteBlock(profile(), [], []), "A Bot's default profile can't be deleted");
  assert.equal(deleteBlock(profile({ id: "p2", default: false }), [], list), "A handoff holds this profile");
  assert.equal(deleteBlock(profile({ id: "p3", default: false }), [controller({ profileId: "p9", actualProfileId: "p3" })], []), "A controller has this profile selected");
  assert.equal(deleteBlock(profile({ id: "p3", default: false }), [controller()], []), null);
  // A retained, unassigned former default can be deleted.
  assert.equal(deleteBlock(profile({ botId: null }), [], []), null);
  assert.equal(controllerKey(controller()), "bot-1/i/default");
});

test("profiles group by Bot in numeric order, unassigned last, defaults first", () => {
  const groups = groupProfiles([profile({ id: "a", botId: null }), profile({ id: "b", botId: "bot-10", default: false }), profile({ id: "c", botId: "bot-2", default: false, createdAt: "2026-09-28T08:00:00Z" }), profile({ id: "d", botId: "bot-2" })]);
  assert.deepEqual(groups.map((group) => [group.botId, group.profiles.map((item) => item.id)]), [["bot-2", ["d", "c"]], ["bot-10", ["b"]], [null, ["a"]]]);
});

test("an identical retry reuses the stored intent; a new decision mints a new request", () => {
  let n = 0;
  const mint = () => `req-${++n}`;
  const take = intentFor("take", handoff(), null, {}, mint);
  assert.deepEqual(take, { kind: "take", args: { id: "h1", expectedRevision: 3, requestId: "req-1" } });
  // Unknown outcome, nothing changed: the same request.
  assert.equal(intentFor("take", handoff(), take, {}, mint), take);
  // The take landed and the page reloaded: Reopen repeats the original take despite the newer revision.
  assert.equal(intentFor("take", handoff({ state: "human_controlling", revision: 5 }), take, {}, mint), take);
  // Someone else moved it on: a fresh request against the current revision.
  assert.deepEqual(intentFor("take", handoff({ revision: 6 }), take, {}, mint).args, { id: "h1", expectedRevision: 6, requestId: "req-2" });

  const finish = intentFor("finish", handoff({ state: "human_controlling", revision: 5 }), take, { outcome: "completed", note: "  Signed in  " }, mint);
  assert.deepEqual(finish.args, { id: "h1", expectedRevision: 5, requestId: "req-3", outcome: "completed", note: "Signed in" });
  assert.equal(intentFor("finish", handoff({ state: "returning", revision: 6 }), finish, { outcome: "completed", note: "Signed in" }, mint), finish);
  // A different choice is a different intent.
  assert.notEqual(intentFor("finish", handoff({ state: "human_controlling", revision: 5 }), finish, { outcome: "skipped" }, mint), finish);
  assert.equal("note" in intentFor("finish", handoff(), null, { outcome: "skipped", note: " " }, mint).args, false);
});

test("intents persist per handoff and ignore malformed storage", () => {
  const storage = memory();
  const intent = { kind: "take", args: { id: "h1", expectedRevision: 3, requestId: "req-1" } };
  saveIntent(storage, intent, "h1");
  assert.deepEqual(loadIntent(storage, "h1"), intent);
  assert.equal(loadIntent(storage, "h2"), null);
  storage.setItem("agentstack.uix.browse.intent.h3", "{not json");
  assert.equal(loadIntent(storage, "h3"), null);
  storage.setItem("agentstack.uix.browse.intent.h4", JSON.stringify({ kind: "take", args: { id: "other", requestId: "x" } }));
  assert.equal(loadIntent(storage, "h4"), null);
  saveIntent(storage, null, "h1");
  assert.equal(loadIntent(storage, "h1"), null);
  assert.equal(loadIntent(null, "h1"), null);
});

test("viewer windows switch the primary, keep pinned viewers, prune deleted profiles and never persist grants", () => {
  const storage = memory();
  const store = new ViewerWindowStore();
  store.attach(storage);
  assert.equal(store.show("p1"), primaryViewer);
  const second = store.open("p2");
  assert.equal(second, "browse-viewer-2");
  assert.equal(store.show("p2"), second);
  store.grant("h1", "http://127.0.0.1:1/secret/");
  assert.deepEqual(store.getGrants(), { h1: "http://127.0.0.1:1/secret/" });
  assert.ok(![...storage.values.values()].some((value) => value.includes("secret")), "grants stay in memory");
  store.pruneGrants(new Set(["h9"]));
  assert.deepEqual(store.getGrants(), {});
  store.prune(new Set(["p2"]));
  assert.deepEqual(store.getWindows(), [{ id: primaryViewer, profileId: null }, { id: second, profileId: "p2" }]);
  store.close(second);
  store.close(primaryViewer);
  assert.deepEqual(store.getWindows(), [{ id: primaryViewer, profileId: null }]);

  const restored = new ViewerWindowStore();
  storage.setItem("agentstack.uix.browse-viewers.v1", JSON.stringify([{ id: "browse-viewer-3", profileId: "p3" }, { id: "evil", profileId: "p4" }, { id: "browse-viewer-3", profileId: "dup" }]));
  restored.attach(storage);
  assert.deepEqual(restored.getWindows(), [{ id: primaryViewer, profileId: null }, { id: "browse-viewer-3", profileId: "p3" }]);
});
