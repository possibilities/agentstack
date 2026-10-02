import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { extname } from "node:path";
import test from "node:test";

registerHooks({ resolve(specifier, context, next) {
  return next(context.parentURL?.includes("/lib/stack/") && specifier.startsWith("./") && !extname(specifier) ? `${specifier}.ts` : specifier, context);
} });
const source = await import("../lib/stack/source.ts");
const watches = await import("../lib/stack/source-watches.ts");

const id = "22222222-2222-4222-8222-222222222222";
const delivery = (sequence, extra = {}) => ({ sequence, endpointId: "11111111-1111-4111-8111-111111111111", deliveryId: `guid-${sequence}`, event: "issues", action: "opened",
  receivedAt: "2026-10-01T12:00:00.000Z", contentType: "application/json", hookId: null, targetType: null, targetId: null, repository: "owner/project", repositoryId: 3,
  organization: null, enterprise: null, sender: "human", installationId: null, ref: null, sha: null, entities: [], payloadBytes: 10, payloadSha256: "0".repeat(64),
  payloadClearedAt: null, knownEvent: true, ...extra });

/**
 * An owner that answers like github_watch_read / github_watch_acknowledge: oldest pending first from the consumption cursor (or an
 * explicit exclusive `after`), `through` the newest matched sequence, a page cut short by `cap`, and the same refusals.
 */
function owner({ matches = [], acknowledgedThrough = 0, startAfter = 0, cap = Infinity, latest } = {}) {
  const watch = { id, label: "Reviews", filter: {}, enabled: true, revision: 1, startAfter, acknowledgedThrough, createdAt: "2026-10-01T12:00:00.000Z", updatedAt: "2026-10-01T12:00:00.000Z", scope: `watch:${id}` };
  const rows = matches.map((sequence) => delivery(sequence));
  const calls = { read: [], acknowledge: [] };
  const fail = { read: null, acknowledge: null, afterAcknowledge: null };
  const head = () => latest ?? Math.max(startAfter, ...rows.map((row) => row.sequence), 0);
  const read = async (input) => {
    calls.read.push(input);
    if (fail.read) throw fail.read;
    const cursor = input.after ?? watch.acknowledgedThrough;
    if (cursor < watch.startAfter || cursor > head()) throw new Error("github_cursor_invalid");
    const pool = rows.filter((row) => row.sequence > cursor);
    const entries = pool.slice(0, Math.min(input.limit, cap));
    return { watch: { ...watch }, entries: entries.map((entry) => ({ ...entry })), pending: rows.filter((row) => row.sequence > watch.acknowledgedThrough).length,
      through: rows.length ? rows[rows.length - 1].sequence : watch.startAfter, nextCursor: pool.length > entries.length ? entries.at(-1).sequence : null };
  };
  const acknowledge = async (input) => {
    calls.acknowledge.push(input);
    if (fail.acknowledge) { const error = fail.acknowledge; if (fail.afterAcknowledge) fail.afterAcknowledge(); throw error; }
    if (input.through === watch.acknowledgedThrough) return { ...watch };
    if (watch.acknowledgedThrough !== input.expectedAcknowledgedThrough) throw new Error("github_watch_cursor_changed");
    if (input.through < watch.acknowledgedThrough || input.through > head()) throw new Error("github_cursor_invalid");
    watch.acknowledgedThrough = input.through;
    return { ...watch };
  };
  return { watch, rows, calls, fail, read, acknowledge, arrive: (sequence) => rows.push(delivery(sequence)), anotherConsumer: (through) => { watch.acknowledgedThrough = through; } };
}
const inbox = (o, limit) => new watches.WatchInbox(o.read, o.acknowledge, limit);
const sequences = (state) => state.entries.map((entry) => entry.sequence);

/* ---------- a frozen definition ---------- */

const draft = (extra = {}) => ({ id, label: "  Reviews  ", filter: { ...source.emptyDraft, events: "pull_request", repositories: "owner/project" }, start: { kind: "now" }, ...extra });

test("a definition is frozen exactly as reviewed: later edits to the draft change nothing", () => {
  const work = draft();
  const result = watches.freezeWatch(work, 12);
  assert.ok(result.ok);
  const { frozen } = result;
  assert.deepEqual(frozen.input, { id, label: "Reviews", filter: { events: ["pull_request"], repositories: ["owner/project"] }, start: "now" });
  assert.equal(frozen.json, JSON.stringify(JSON.parse(frozen.json), null, 2), "the review prints the same text it sends");
  assert.deepEqual(JSON.parse(frozen.json), JSON.parse(JSON.stringify(frozen.input)), "the request is exactly the reviewed text");
  assert.equal(source.canonicalJson(frozen.input, 2), frozen.json);
  work.label = "Changed"; work.filter.events = "issues"; work.start = { kind: "after", text: "3" };
  assert.equal(frozen.input.label, "Reviews");
  assert.deepEqual(frozen.input.filter.events, ["pull_request"]);
  assert.equal(frozen.input.start, "now");
  assert.ok(Object.isFrozen(frozen.input) && Object.isFrozen(frozen.input.filter) && Object.isFrozen(frozen.input.filter.events));
  assert.throws(() => { "use strict"; frozen.input.filter.events.push("issues"); }, TypeError);
});

test("a frozen filter keeps scalar types: false, 0, null and the text false stay different", () => {
  const predicates = [
    { path: "/a", op: "equals", type: "boolean", value: "false" }, { path: "/b", op: "equals", type: "number", value: "0" }, { path: "/c", op: "equals", type: "null", value: "" },
    { path: "/d", op: "equals", type: "string", value: "false" }, { path: "/e", op: "one_of", type: "json", value: "\"x\"\n1\nfalse\nnull" },
  ];
  const result = watches.freezeWatch(draft({ filter: { ...source.emptyDraft, predicates } }), 5);
  assert.ok(result.ok);
  assert.deepEqual(result.frozen.input.filter.predicates, [
    { op: "equals", path: "/a", value: false }, { op: "equals", path: "/b", value: 0 }, { op: "equals", path: "/c", value: null }, { op: "equals", path: "/d", value: "false" },
    { op: "one_of", path: "/e", values: ["x", 1, false, null] },
  ]);
  assert.match(result.frozen.filterJson, /"value": false/);
  assert.match(result.frozen.filterJson, /"value": "false"/);
});

test("a definition needs a UUID, a label, a valid filter and a start the owner can honor", () => {
  const bad = (work, latest = 10) => { const result = watches.freezeWatch(work, latest); assert.equal(result.ok, false); return result.errors.join(" | "); };
  assert.match(bad(draft({ id: "nope" })), /UUID/);
  assert.match(bad(draft({ label: "   " })), /label/);
  assert.match(bad(draft({ label: "x".repeat(201) })), /200/);
  assert.match(bad(draft({ filter: { ...source.emptyDraft, repositories: "not a repo" } })), /owner\/name/);
  for (const text of ["-1", "1.5", "01", "x", ""]) assert.match(bad(draft({ start: { kind: "after", text } })), /whole sequence/, `start ${text}`);
  assert.match(bad(draft({ start: { kind: "after", text: "11" } }), 10), /beyond the newest arrival \(#10\)/);
  assert.ok(watches.freezeWatch(draft({ start: { kind: "after", text: "0" } }), 10).ok, "after #0 backfills everything retained");
  assert.ok(watches.freezeWatch(draft({ start: { kind: "after", text: "10" } }), 10).ok, "after the newest is the same as now, and allowed");
  assert.ok(watches.freezeWatch(draft({ start: { kind: "after", text: "3" } }), null).ok, "an unknown newest sequence leaves the owner to refuse");
});

test("the review warns when a backfill uses payload predicates, and when nothing is filtered", () => {
  const withPredicate = { ...source.emptyDraft, predicates: [{ path: "/action", op: "equals", type: "string", value: "opened" }] };
  const backfill = watches.freezeWatch(draft({ filter: withPredicate, start: { kind: "after", text: "4" } }), 9);
  assert.ok(backfill.ok);
  assert.ok(backfill.notes.some((note) => /cleared/.test(note) && /Backfill/.test(note)));
  const now = watches.freezeWatch(draft({ filter: withPredicate }), 9);
  assert.ok(now.ok);
  assert.equal(now.notes.length, 0, "a watch from now meets only retained bodies");
  const empty = watches.freezeWatch(draft({ filter: { ...source.emptyDraft } }), 9);
  assert.ok(empty.ok && empty.notes.some((note) => /every delivery/i.test(note)));
});

test("start wording says what is examined", () => {
  assert.match(watches.startWords("now", 12), /Starts now.*#12/);
  assert.match(watches.startWords("now", 12), /Nothing already stored is examined/);
  assert.match(watches.startWords(4, 12), /#5 through #12/);
  assert.match(watches.startWords(12, 12), /Backfills from after #12:/);
});

test("filter summaries and examples carry the exact watch and never an acknowledgement", () => {
  assert.equal(watches.filterSummary({}), "Every delivery");
  assert.equal(watches.filterSummary({ events: ["issues", "push"], repositories: ["o/r"] }), "Event: issues or push · Repository: o/r");
  const examples = watches.watchExamples(id);
  assert.deepEqual(JSON.parse(examples.subscribe), { topic: "github_watches_changed", scope: `watch:${id}`, readOperation: "github_watch_read", readArguments: { id } });
  assert.deepEqual(JSON.parse(examples.poll).params, { name: "github_delivery", arguments: { id }, cursor: null });
  assert.deepEqual(JSON.parse(examples.listen).params, { name: "events_listen", arguments: { name: "github_delivery", arguments: { id }, policy: "native" } });
  for (const text of Object.values(examples)) assert.doesNotMatch(text, /acknowledge/i);
});

/* ---------- the review boundary ---------- */

test("only an unbroken run of marked entries from the oldest can be acknowledged", () => {
  const entries = [4, 7, 9, 12].map((sequence) => ({ sequence }));
  assert.deepEqual(watches.reviewPlan(entries, [], []), { through: null, first: null, count: 0, skipped: [], stranded: [] });
  assert.equal(watches.reviewPlan(entries, [7, 9], [7, 9]).through, null, "marking later entries does not reach past the unreviewed oldest");
  assert.deepEqual(watches.reviewPlan(entries, [7, 9], [7, 9]).stranded, [7, 9]);
  const plan = watches.reviewPlan(entries, [4, 7, 12], [4, 7, 12]);
  assert.equal(plan.through, 7);
  assert.equal(plan.count, 2);
  assert.deepEqual(plan.stranded, [12], "a mark after a gap stays out of the range");
  assert.deepEqual(watches.reviewPlan(entries, [4, 7, 9, 12], [4, 7, 9, 12]), { through: 12, first: 4, count: 4, skipped: [], stranded: [] });
});

test("entries marked without opening their details are named as skipped", () => {
  const entries = [4, 7, 9].map((sequence) => ({ sequence }));
  const plan = watches.reviewPlan(entries, [4, 7, 9], [7]);
  assert.deepEqual(plan.skipped, [4, 9]);
  assert.equal(plan.through, 9);
  assert.deepEqual(watches.reviewPlan(entries, [4, 7], [4, 7, 9]).skipped, [], "an opened entry outside the range is not skipped");
});

test("marking through an entry marks every older loaded entry once, and unmarking breaks the run", () => {
  const entries = [4, 7, 9, 12].map((sequence) => ({ sequence }));
  assert.deepEqual(watches.markThrough(entries, [], 9), [4, 7, 9]);
  assert.deepEqual(watches.markThrough(entries, [12], 7), [4, 7, 12]);
  assert.deepEqual(watches.toggleMark([4, 7, 9], 7, false), [4, 9]);
  assert.equal(watches.reviewPlan(entries, watches.toggleMark([4, 7, 9], 7, false), []).through, 4);
  assert.deepEqual(watches.toggleMark([9], 4, true), [4, 9]);
});

/* ---------- the inbox ---------- */

test("opening, paging and refreshing an inbox never acknowledge, even with entries marked", async () => {
  const o = owner({ matches: [3, 5, 8, 9, 14], cap: 2 });
  const view = inbox(o, 2);
  await view.open(id);
  assert.deepEqual(sequences(view.getState()), [3, 5]);
  assert.equal(view.getState().base, 0);
  assert.deepEqual(o.calls.read[0], { id, limit: 2 }, "the first read takes the owner's cursor: no `after`, no `through`");
  view.markThrough(5);
  await view.more();
  await view.more();
  assert.deepEqual(sequences(view.getState()), [3, 5, 8, 9, 14]);
  assert.deepEqual(o.calls.read.map((call) => call.after), [undefined, 5, 9], "paging follows the owner's exclusive nextCursor");
  assert.ok(o.calls.read.every((call) => !("through" in call)), "the owner offers no pin for a watch read");
  o.arrive(21);
  view.invalidate(0);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await view.refresh();
  view.close();
  await view.open(id);
  await view.reload();
  assert.equal(o.calls.acknowledge.length, 0, "no read, notice, refresh or reopen is an acknowledgement");
  assert.equal(o.watch.acknowledgedThrough, 0);
});

test("the inbox is not a pinned snapshot: matches that arrive while reading are announced and appended only on request", async () => {
  const o = owner({ matches: [3, 5], cap: 25 });
  const view = inbox(o);
  await view.open(id);
  assert.deepEqual(sequences(view.getState()), [3, 5]);
  assert.equal(view.getState().firstThrough, 5);
  assert.equal(watches.unloaded(view.getState()), 0);
  o.arrive(7); o.arrive(8);
  await view.refresh();
  const state = view.getState();
  assert.deepEqual(sequences(state), [3, 5], "loaded rows never move");
  assert.equal(state.through, 8, "the matched high-water moved");
  assert.ok(state.through > state.firstThrough, "matches arrived after this inbox was opened");
  assert.equal(state.pending, 4);
  assert.equal(watches.unloaded(state), 2);
  await view.more();
  assert.deepEqual(sequences(view.getState()), [3, 5, 7, 8]);
  assert.equal(watches.unloaded(view.getState()), 0);
  assert.equal(o.calls.read.at(-1).after, 5, "the tail read follows the last loaded entry");
});

test("a refresh replaces summaries in place without moving the reading position or the marks", async () => {
  const o = owner({ matches: [3, 5, 8] });
  const view = inbox(o);
  await view.open(id);
  view.markThrough(5);
  view.markOpened(3);
  o.rows[0].payloadClearedAt = "2026-10-02T00:00:00.000Z";
  await view.refresh();
  const state = view.getState();
  assert.equal(state.entries[0].payloadClearedAt, "2026-10-02T00:00:00.000Z");
  assert.deepEqual(state.marked, [3, 5]);
  assert.deepEqual(state.opened, [3]);
  assert.equal(o.calls.acknowledge.length, 0);
});

test("acknowledging sends the reviewed boundary with the cursor the rows were read from, then reads the new pending run", async () => {
  const o = owner({ matches: [3, 5, 8, 9] });
  const view = inbox(o);
  await view.open(id);
  assert.equal(await view.acknowledge(), "not-offered", "nothing is marked");
  view.mark(5, true);
  assert.equal(await view.acknowledge(), "not-offered", "a later mark does not reach past the unreviewed oldest");
  assert.equal(o.calls.acknowledge.length, 0);
  view.markThrough(5);
  view.markOpened(3);
  assert.equal(await view.acknowledge(9), "not-offered", "a boundary the person did not confirm is refused");
  assert.equal(await view.acknowledge(5), "acknowledged");
  assert.deepEqual(o.calls.acknowledge, [{ id, through: 5, expectedAcknowledgedThrough: 0 }]);
  const state = view.getState();
  assert.equal(state.base, 5);
  assert.deepEqual(sequences(state), [8, 9], "the inbox is read again from the new cursor");
  assert.deepEqual(state.marked, [], "the reviewed entries are gone and nothing else was marked");
  assert.equal(state.notice.kind, "acknowledged");
  assert.deepEqual(state.notice.skipped, [5], "5 was marked without opening its details");
  assert.equal(state.pending, 2);
});

test("a mark beyond the acknowledged run survives the acknowledgement", async () => {
  const o = owner({ matches: [3, 5, 8] });
  const view = inbox(o);
  await view.open(id);
  view.markThrough(3);
  view.mark(8, true);
  assert.equal(await view.acknowledge(), "acknowledged");
  assert.deepEqual(o.calls.acknowledge, [{ id, through: 3, expectedAcknowledgedThrough: 0 }]);
  assert.deepEqual(view.getState().marked, [8], "8 was reviewed deliberately and is still pending, behind the unmarked 5");
  assert.equal(watches.acknowledgement(view.getState()).plan.through, null);
});

test("a compare-and-set conflict reads the inbox again, clears every mark, and does not retry", async () => {
  const o = owner({ matches: [3, 5, 8, 9] });
  const view = inbox(o);
  await view.open(id);
  view.markThrough(8);
  o.anotherConsumer(5);
  assert.equal(await view.acknowledge(), "conflict");
  assert.equal(o.calls.acknowledge.length, 1, "no automatic retry");
  assert.deepEqual(o.calls.acknowledge[0], { id, through: 8, expectedAcknowledgedThrough: 0 });
  const state = view.getState();
  assert.equal(state.notice.kind, "conflict");
  assert.equal(state.notice.attempted, 8);
  assert.equal(state.notice.expected, 0);
  assert.equal(state.notice.now, 5);
  assert.equal(state.base, 5);
  assert.deepEqual(sequences(state), [8, 9], "the rows are those pending at the cursor as it is now");
  assert.deepEqual(state.marked, [], "review starts over");
  assert.deepEqual(state.opened, []);
  assert.equal(watches.acknowledgement(state).plan.through, null, "nothing is acknowledgeable until it is reviewed again");
  assert.equal(await view.acknowledge(), "not-offered");
  assert.equal(o.calls.acknowledge.length, 1);
});

test("a cursor that moved elsewhere while reading replaces the rows and clears review, with no acknowledgement", async () => {
  const o = owner({ matches: [3, 5, 8, 9] });
  const view = inbox(o);
  await view.open(id);
  view.markThrough(5);
  o.anotherConsumer(5);
  await view.refresh();
  const state = view.getState();
  assert.deepEqual(state.notice, { kind: "moved", from: 0, to: 5 });
  assert.equal(state.base, 5);
  assert.deepEqual(sequences(state), [8, 9]);
  assert.deepEqual(state.marked, []);
  assert.equal(o.calls.acknowledge.length, 0);
  // Paging notices it too, before any older rows are appended to newer ones.
  const p = owner({ matches: [3, 5, 8, 9], cap: 2 });
  const paging = inbox(p, 2);
  await paging.open(id);
  p.anotherConsumer(5);
  await paging.more();
  assert.equal(paging.getState().notice.kind, "moved");
  assert.deepEqual(sequences(paging.getState()), [8, 9]);
});

test("a lost acknowledgement reads the cursor back and assumes nothing", async () => {
  // Applied before the answer was lost.
  const applied = owner({ matches: [3, 5, 8] });
  const a = inbox(applied);
  await a.open(id);
  a.markThrough(5);
  applied.fail.acknowledge = new Error("socket closed");
  applied.fail.afterAcknowledge = () => applied.anotherConsumer(5);
  assert.equal(await a.acknowledge(), "acknowledged");
  assert.equal(a.getState().notice.confirmedByReading, true);
  assert.equal(a.getState().base, 5);
  assert.equal(applied.calls.acknowledge.length, 1, "never resent");

  // Not applied: the reviewed rows and marks stay, and the person decides.
  const lost = owner({ matches: [3, 5, 8] });
  const b = inbox(lost);
  await b.open(id);
  b.markThrough(5);
  lost.fail.acknowledge = new Error("socket closed");
  assert.equal(await b.acknowledge(), "refused");
  assert.equal(b.getState().notice.kind, "refused");
  assert.deepEqual(b.getState().marked, [3, 5]);
  assert.equal(b.getState().base, 0);
  assert.equal(lost.calls.acknowledge.length, 1);

  // The cursor cannot be read back either.
  const dark = owner({ matches: [3, 5] });
  const c = inbox(dark);
  await c.open(id);
  c.markThrough(3);
  dark.fail.acknowledge = new Error("socket closed");
  dark.fail.read = new Error("socket closed");
  assert.equal(await c.acknowledge(), "unknown");
  assert.deepEqual(c.getState().notice, { kind: "unknown", attempted: 3, expected: 0, error: "socket closed" });
  assert.deepEqual(c.getState().marked, [3], "an unconfirmed result keeps what was reviewed");
});

test("a removed watch is gone, not an error to retry", async () => {
  const o = owner({ matches: [3] });
  const view = inbox(o);
  o.fail.read = new Error("github_watch_not_found");
  await view.open(id);
  assert.equal(view.getState().gone, true);
  assert.equal(view.getState().error, null);
});

test("an answer for an older inbox is dropped when another watch is opened", async () => {
  const o = owner({ matches: [3, 5] });
  let release;
  const slow = new watches.WatchInbox(async (input) => { if (input.id === id) await new Promise((resolve) => { release = resolve; }); return o.read({ ...input, id }); }, o.acknowledge);
  const first = slow.open(id);
  const second = slow.open("33333333-3333-4333-8333-333333333333");
  release?.();
  await first;
  await second;
  assert.equal(slow.getState().watchId, "33333333-3333-4333-8333-333333333333");
  slow.close();
  assert.equal(slow.getState().watchId, null);
});
