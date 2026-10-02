import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { registerHooks } from "node:module";
import { extname } from "node:path";
import test from "node:test";

registerHooks({ resolve(specifier, context, next) {
  return next(context.parentURL?.includes("/lib/stack/") && specifier.startsWith("./") && !extname(specifier) ? `${specifier}.ts` : specifier, context);
} });
const source = await import("../lib/stack/source.ts");

const delivery = (sequence, extra = {}) => ({ sequence, endpointId: "11111111-1111-4111-8111-111111111111", deliveryId: `guid-${sequence}`, event: "issues", action: "opened",
  receivedAt: "2026-10-01T12:00:00.000Z", contentType: "application/json", hookId: null, targetType: null, targetId: null, repository: "owner/project", repositoryId: 3,
  organization: null, enterprise: null, sender: "human", installationId: null, ref: null, sha: null, entities: [], payloadBytes: 10, payloadSha256: "0".repeat(64),
  payloadClearedAt: null, knownEvent: true, ...extra });

/** An owner that answers like github_delivery_list: oldest first, exclusive `after`, a pinned `through`, and a page cut short by `cap` (the response-byte bound). */
function owner(initial, { cap = Infinity, match = () => true } = {}) {
  const rows = initial.map((sequence) => delivery(sequence));
  const calls = [];
  const read = async (input) => {
    calls.push(input);
    const latest = rows.length ? rows[rows.length - 1].sequence : 0;
    const through = Math.min(input.through ?? latest, latest);
    if (through < input.after) throw new Error("github_cursor_invalid");
    const entries = [];
    let scanned = input.after, truncated = false;
    for (const row of rows.filter((item) => item.sequence > input.after && item.sequence <= through)) {
      if (entries.length === Math.min(input.limit, cap)) { truncated = true; break; }
      if (match(row, input.filter)) entries.push({ ...row });
      scanned = row.sequence;
    }
    return { entries, after: input.after, through, nextCursor: truncated && scanned < through ? scanned : null };
  };
  const get = async (sequence) => ({ ...rows.find((row) => row.sequence === sequence) });
  return { rows, calls, read, get, add: (sequence) => rows.push(delivery(sequence)) };
}

test("a list draft keeps scalar types: false, 0 and null are values, not absences", () => {
  const { filter, errors } = source.buildFilter({ ...source.emptyDraft, events: "issues, push", predicates: [
    { path: "/draft", op: "equals", type: "boolean", value: "false" },
    { path: "/count", op: "equals", type: "number", value: "0" },
    { path: "/merged_at", op: "equals", type: "null", value: "" },
    { path: "/label", op: "equals", type: "string", value: "false" },
    { path: "/action", op: "one_of", type: "string", value: "opened\nclosed, with comma" },
    { path: "/number", op: "one_of", type: "number", value: "1\n2.5" },
    { path: "/title", op: "starts_with", type: "string", value: "fix" },
    { path: "/pull_request", op: "exists", type: "boolean", value: "false" },
    { path: "/labels", op: "contains", type: "string", value: "bug" },
    { path: "/mixed", op: "one_of", type: "json", value: "\"a\"\n1\nnull\nfalse" },
  ] });
  assert.deepEqual(errors, []);
  assert.deepEqual(filter.events, ["issues", "push"]);
  assert.deepEqual(filter.predicates, [
    { path: "/draft", op: "equals", value: false },
    { path: "/count", op: "equals", value: 0 },
    { path: "/merged_at", op: "equals", value: null },
    { path: "/label", op: "equals", value: "false" },
    { path: "/action", op: "one_of", values: ["opened", "closed, with comma"] },
    { path: "/number", op: "one_of", values: [1, 2.5] },
    { path: "/title", op: "starts_with", value: "fix" },
    { path: "/pull_request", op: "exists", value: false },
    { path: "/labels", op: "contains", value: "bug" },
    { path: "/mixed", op: "one_of", values: ["a", 1, null, false] },
  ]);
  assert.match(source.buildFilter({ ...source.emptyDraft, predicates: [{ path: "/m", op: "one_of", type: "json", value: "{}" }] }).errors[0], /not one JSON string, number, boolean or null/);
  const text = (value) => source.filterKey({ predicates: [{ path: "/x", op: "equals", value }] });
  assert.equal(new Set([text(false), text("false"), text(null), text("null"), text(0), text("0")]).size, 6, "every scalar type serializes distinctly");
  assert.equal(source.filterKey({ events: ["a"], actions: ["b"] }), source.filterKey({ actions: ["b"], events: ["a"] }), "key order does not make a different filter");
});

test("invalid drafts name the field, and only the five predicate operators exist", () => {
  const { errors } = source.buildFilter({ ...source.emptyDraft, events: "Issues", repositories: "no-slash", installationIds: "12, x", predicates: [
    { path: "action", op: "equals", type: "string", value: "x" },
    { path: "/n", op: "equals", type: "number", value: "0x10" },
    { path: "/b", op: "equals", type: "boolean", value: "yes" },
    { path: "/e", op: "exists", type: "boolean", value: "" },
  ] });
  assert.equal(errors.length, 7);
  assert.match(errors.join("\n"), /Events: “Issues”/);
  assert.match(errors.join("\n"), /Repositories: “no-slash”/);
  assert.match(errors.join("\n"), /Installation IDs: “x”/);
  assert.deepEqual(source.predicateOps.map((item) => item.op), ["equals", "one_of", "contains", "starts_with", "exists"]);
  assert.equal(source.buildFilter({ ...source.emptyDraft, predicates: Array.from({ length: 33 }, () => ({ path: "/a", op: "exists", type: "boolean", value: "true" })) }).errors[0], "Predicates: at most 32");
  assert.match(source.buildFilter({ ...source.emptyDraft, repositories: Array.from({ length: 51 }, (_, index) => `o/r${index}`).join(",") }).errors[0], /at most 50/);
});

test("a filter round trips through its draft and reads as AND between fields, OR within one", () => {
  const filter = { endpointIds: ["11111111-1111-4111-8111-111111111111"], events: ["issues", "push"], predicates: [{ path: "/draft", op: "equals", value: false }, { path: "/x", op: "one_of", values: [null, 1] }] };
  assert.equal(source.filterKey(source.buildFilter(source.draftFromFilter(filter)).filter), source.filterKey(filter));
  const described = source.describeFilter(filter, () => "Receiver one");
  assert.deepEqual(described.map((item) => item.label), ["Receiver", "Event", "Payload", "Payload"]);
  assert.deepEqual(described[1].values, ["issues", "push"]);
  assert.equal(described[2].values[0], "/draft equals false");
  assert.equal(described[3].values[0], "/x is one of [null,1]");
  assert.equal(source.filterIsEmpty({}), true);
});

test("the ledger pins the first watermark, follows the exclusive cursor and treats a short page as unfinished", async () => {
  const fake = owner(Array.from({ length: 9 }, (_, index) => index + 1), { cap: 2 });
  const ledger = new source.SourceLedger(fake.read, fake.get, 5);
  await ledger.start({});
  let state = ledger.getState();
  assert.equal(state.through, 9);
  assert.deepEqual(state.entries.map((entry) => entry.sequence), [1, 2], "a response cap shortens the page below the requested five");
  assert.equal(state.complete, false, "a short page is not the end");
  assert.equal(state.nextCursor, 2);
  fake.add(10); fake.add(11);
  await ledger.more();
  state = ledger.getState();
  assert.deepEqual(fake.calls.map((call) => [call.after, call.through]), [[0, undefined], [2, 9]], "later pages send the pinned through and the exclusive cursor");
  assert.deepEqual(state.entries.map((entry) => entry.sequence), [1, 2, 3, 4]);
  while (ledger.getState().nextCursor !== null) await ledger.more();
  state = ledger.getState();
  assert.deepEqual(state.entries.map((entry) => entry.sequence), [1, 2, 3, 4, 5, 6, 7, 8, 9], "arrivals after the watermark never appear in this snapshot");
  assert.equal(state.complete, true);
  assert.equal(state.through, 9);
  await ledger.more();
  assert.equal(fake.calls.length, 5, "a finished snapshot makes no further reads");
  assert.deepEqual(source.newerArrivals(state, 11), { available: true, latest: 11, canExtend: true });
  assert.deepEqual(source.newerArrivals(state, 9), { available: false, latest: 9, canExtend: false });
});

test("new arrivals never move the reading position until extended, and extending only appends", async () => {
  const fake = owner([1, 2, 3], { cap: 2 });
  const ledger = new source.SourceLedger(fake.read, fake.get, 5);
  await ledger.start({});
  fake.add(4); fake.add(5);
  assert.deepEqual(source.newerArrivals(ledger.getState(), 5), { available: true, latest: 5, canExtend: false }, "an unfinished snapshot cannot be extended past its watermark");
  await ledger.extend();
  assert.equal(fake.calls.length, 1, "extend is refused before the snapshot ends");
  await ledger.more();
  assert.equal(ledger.getState().complete, true);
  const before = ledger.getState().entries;
  await ledger.extend();
  const state = ledger.getState();
  assert.equal(state.through, 5, "the watermark advances only on an explicit extension");
  assert.deepEqual(state.entries.slice(0, 3), before, "what was loaded keeps its place");
  assert.deepEqual(fake.calls.at(-1), { after: 3, limit: 5, filter: {} });
  assert.deepEqual(state.entries.map((entry) => entry.sequence), [1, 2, 3, 4, 5].filter((sequence) => state.entries.some((entry) => entry.sequence === sequence)));
  while (ledger.getState().nextCursor !== null) await ledger.more();
  assert.deepEqual(ledger.getState().entries.map((entry) => entry.sequence), [1, 2, 3, 4, 5]);
});

test("an empty answer that still carries a cursor is not the end of the selection", async () => {
  const answers = [{ entries: [], after: 0, through: 12, nextCursor: 6 }, { entries: [], after: 6, through: 12, nextCursor: 9 }, { entries: [delivery(11)], after: 9, through: 12, nextCursor: null }];
  const sent = [];
  const ledger = new source.SourceLedger(async (input) => { sent.push(input); return answers.shift(); }, async () => delivery(1), 3);
  await ledger.start({ events: ["issues"] });
  assert.deepEqual(ledger.getState().entries, []);
  assert.equal(ledger.getState().complete, false, "no matches on this page, yet the owner has not finished");
  while (ledger.getState().nextCursor !== null) await ledger.more();
  assert.deepEqual(ledger.getState().entries.map((entry) => entry.sequence), [11]);
  assert.equal(ledger.getState().complete, true);
  assert.deepEqual(sent.map((input) => [input.after, input.through]), [[0, undefined], [6, 12], [9, 12]]);
});

test("a changed filter starts a fresh session and drops the answer to the old one", async () => {
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  const fake = owner([1, 2, 3, 4]);
  let n = 0;
  const read = async (input) => { n++; if (n === 1) await slow; return fake.read(input); };
  const ledger = new source.SourceLedger(read, fake.get, 2);
  const first = ledger.start({ events: ["push"] });
  const second = ledger.start({ events: ["issues"] });
  release();
  await Promise.all([first, second]);
  const state = ledger.getState();
  assert.equal(state.session, 2);
  assert.deepEqual(state.filter, { events: ["issues"] });
  assert.equal(state.key, source.filterKey({ events: ["issues"] }));
  assert.deepEqual(state.entries.map((entry) => entry.sequence), [1, 2]);
  assert.equal(state.busy, null);
  await ledger.start({});
  assert.deepEqual(ledger.getState().detached, [], "a fresh session keeps nothing from the previous one");
});

test("a failed first page is an error, not an empty ledger, and a failed later page keeps what was read", async () => {
  const fake = owner([1, 2, 3, 4], { cap: 2 });
  let fail = true;
  const read = async (input) => { if (fail) throw new Error("socket down"); return fake.read(input); };
  const ledger = new source.SourceLedger(read, fake.get, 2);
  await ledger.start({});
  assert.equal(ledger.getState().error, "socket down");
  assert.equal(ledger.getState().through, null);
  fail = false;
  await ledger.start({});
  fail = true;
  await ledger.more();
  assert.equal(ledger.getState().error, "socket down");
  assert.deepEqual(ledger.getState().entries.map((entry) => entry.sequence), [1, 2], "loaded rows stay");
  assert.equal(ledger.getState().nextCursor, 2, "and the position is unchanged");
});

test("cleanup revalidation replaces loaded summaries at the pinned watermark and marks rows a payload predicate can no longer match", async () => {
  const fake = owner([1, 2, 3, 4, 5, 6], { match: (row, filter) => !filter.predicates || row.payloadClearedAt === null });
  const ledger = new source.SourceLedger(fake.read, fake.get, 3);
  await ledger.start({});
  await ledger.more();
  fake.add(7);
  fake.rows[1].payloadClearedAt = "2026-10-02T00:00:00.000Z";
  await ledger.revalidate();
  let state = ledger.getState();
  assert.equal(state.entries[1].payloadClearedAt, "2026-10-02T00:00:00.000Z", "the shown row now says its payload was cleared");
  assert.equal(state.entries.length, 6, "arrivals past the watermark are not added");
  assert.ok(fake.calls.slice(2).every((call) => call.through === 6), "revalidation reads at the pinned watermark");
  await ledger.start({ predicates: [{ path: "/action", op: "equals", value: "opened" }] });
  await ledger.more();
  fake.rows[2].payloadClearedAt = "2026-10-02T00:00:00.000Z";
  await ledger.revalidate();
  state = ledger.getState();
  assert.deepEqual(state.detached, [3], "the cleared row stays where it was, marked");
  assert.equal(state.entries.find((entry) => entry.sequence === 3).payloadClearedAt, "2026-10-02T00:00:00.000Z");
  assert.equal(state.entries.length, 6);
  assert.equal(state.refreshError, null);
});

test("a revalidation that fails is stated, and coalesced notices read the range once", async () => {
  const fake = owner([1, 2, 3]);
  let fail = false;
  const read = async (input) => { if (fail) throw new Error("later read failed"); return fake.read(input); };
  const ledger = new source.SourceLedger(read, fake.get, 5);
  await ledger.start({});
  fail = true;
  await ledger.revalidate();
  assert.equal(ledger.getState().refreshError, "later read failed");
  assert.equal(ledger.getState().entries.length, 3);
  fail = false;
  const before = fake.calls.length;
  ledger.invalidate(0); ledger.invalidate(0); ledger.invalidate(0);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fake.calls.length - before, 1, "a burst of notices is one re-read");
  assert.equal(ledger.getState().refreshError, null);
  ledger.dispose();
});

test("capacity speaks in words: full means intake refused, and a refusal is stated even before the limit", () => {
  const payloads = (count, bytes, maxCount = 10_000, maxBytes = 25 * 1024 * 1024) => ({ count, bytes, maxCount, maxBytes });
  assert.equal(source.capacityView(payloads(3, 1000), []).word, "Space available");
  assert.equal(source.capacityView(payloads(3, 21 * 1024 * 1024), []).state, "near");
  assert.equal(source.capacityView(payloads(9_999, 0), []).state, "near");
  const full = source.capacityView(payloads(10_000, 0), []);
  assert.equal(full.state, "full");
  assert.match(full.text, /507 github_storage_full/);
  assert.equal(source.capacityView(payloads(1, 25 * 1024 * 1024), []).state, "full");
  const refused = source.capacityView(payloads(1, 13 * 1024 * 1024), [{ lastFailure: "github_signature_invalid" }, { lastFailure: "github_storage_full" }]);
  assert.equal(refused.state, "refused");
  assert.equal(refused.refusalObserved, true);
  assert.deepEqual(source.sourceAttention({ payloads: payloads(10_000, 0) }, []), ["Payload storage full: intake refused"]);
  assert.deepEqual(source.sourceAttention({ payloads: payloads(1, 1) }, []), []);
  assert.deepEqual(source.sourceAttention(null, null), []);
});

test("payload chunks reassemble in order, restart when the body changed, and verify the digest only when complete", async () => {
  const text = "{\"a\":\"héllo 🐙 <script>alert(1)</script>\"}";
  const digest = createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
  const slice = (offset, limit) => ({ sequence: 5, text: text.slice(offset, offset + limit), totalChars: text.length, nextOffset: offset + limit < text.length ? offset + limit : null, sha256: digest, cleared: false });
  let held = null;
  for (let offset = 0; offset !== null;) {
    const chunk = slice(offset, 7);
    held = source.addChunk(held, chunk, offset);
    assert.ok(held);
    assert.equal(source.payloadComplete(held), chunk.nextOffset === null);
    offset = chunk.nextOffset;
  }
  assert.equal(source.payloadText(held), text);
  assert.equal(held.loaded, text.length);
  assert.equal(await source.verifyDigest(source.payloadText(held), digest), "verified");
  assert.equal(await source.verifyDigest(source.payloadText(held) + " ", digest), "mismatch");
  assert.equal(source.addChunk(held, { ...slice(7, 7), totalChars: text.length + 1 }, 7), null, "a body of another length is not spliced");
  assert.equal(source.addChunk(held, slice(9, 7), 9), null, "a gap is not spliced");
  const cleared = source.addChunk(held, { sequence: 5, text: "", totalChars: 0, nextOffset: null, sha256: digest, cleared: true }, 14);
  assert.equal(cleared.cleared, true);
  assert.deepEqual(cleared.chunks, [], "a cleared body discards what was loaded");
  assert.equal(source.payloadComplete(cleared), false);
});

test("the receiver's five facts stay separate: nothing implies another", () => {
  const endpoint = { id: "11111111-1111-4111-8111-111111111111", label: "Receiver", target: { kind: "repository", repository: "owner/project" }, githubHost: "github.com", publicOrigin: null, path: "/github/webhooks/x",
    webhookUrl: null, enabled: true, revision: 3, secretVersion: 2, previousSecretExpiresAt: null, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
    lastDeliveryAt: null, lastPingAt: null, accepted: 0, duplicates: 0, rejected: 0, lastFailure: null, managedHookId: null, boundTargetId: null };
  let facts = source.receiverFacts(endpoint, null);
  assert.deepEqual(facts.map((fact) => fact.id), ["local", "public", "remote", "receipt", "arrival"]);
  assert.deepEqual(facts.map((fact) => fact.word), ["Enabled", "Origin not set", "No managed hook recorded", "None read here", "None observed"]);
  assert.ok(facts.every((fact) => fact.word !== "Connected"));
  facts = source.receiverFacts({ ...endpoint, enabled: false, webhookUrl: "https://hooks.example.com/github/webhooks/x", managedHookId: 17, lastPingAt: "2026-10-01T10:00:00.000Z", target: { kind: "app" } }, null);
  assert.deepEqual(facts.map((fact) => fact.word), ["Disabled", "Origin set", "Hook 17 recorded", "None read here", "Ping observed"]);
  facts = source.receiverFacts({ ...endpoint, target: { kind: "app" }, lastDeliveryAt: "2026-10-01T11:00:00.000Z" }, null);
  assert.equal(facts[2].word, "Set up by hand");
  assert.equal(facts[4].word, "Delivery observed");
});

test("catalog search finds events by name, action and summary, and schema chunks never splice two versions", () => {
  const entries = [
    { event: "issues", summary: "Activity related to an issue", documentationUrl: "", supportedWebhookTypes: ["repository"], customActions: false, actions: [{ action: "opened", description: "An issue was opened", schemaRef: "" }], cloudOnly: false },
    { event: "push", summary: "Commits pushed", documentationUrl: "", supportedWebhookTypes: ["repository"], customActions: false, actions: [{ action: null, description: "A commit was pushed", schemaRef: "" }], cloudOnly: false },
  ];
  assert.deepEqual(source.searchCatalog(entries, "opened").map((entry) => entry.event), ["issues"]);
  assert.deepEqual(source.searchCatalog(entries, "commit pushed").map((entry) => entry.event), ["push"]);
  assert.equal(source.searchCatalog(entries, "").length, 2);
  assert.equal(source.searchCatalog(entries, "future_event").length, 0, "an unlisted name is simply not suggested; it remains a valid filter value");
  const chunk = (version, offset, text, total) => ({ variant: "api.github.com", sourceVersion: version, totalChars: total, text, nextOffset: offset + text.length < total ? offset + text.length : null });
  let held = source.addSchemaChunk(null, chunk("v1", 0, "abc", 6), 0);
  held = source.addSchemaChunk(held, chunk("v1", 3, "def", 6), 3);
  assert.equal(held.text, "abcdef");
  assert.equal(held.nextOffset, null);
  const restarted = source.addSchemaChunk(held, chunk("v2", 3, "xyz", 6), 3);
  assert.equal(restarted.restarted, true, "a chunk of another version starts the read over");
  assert.equal(restarted.text, "xyz");
});

test("delivery text helpers describe what arrived from untrusted names without interpreting them", () => {
  assert.equal(source.deliveryName({ event: "issues", action: "opened" }), "issues.opened");
  assert.equal(source.deliveryName({ event: "push", action: null }), "push");
  assert.equal(source.primaryEntity({ entities: [{ kind: "issue", id: 7, number: 4, title: "<img src=x onerror=alert(1)>", url: "javascript:alert(1)", state: null, conclusion: null }] }), "issue #4 · <img src=x onerror=alert(1)>");
  assert.equal(source.primaryEntity({ entities: [] }), null);
  assert.deepEqual(source.deliverySubject({ repository: "owner/project", organization: null, enterprise: null, sender: "h", ref: "refs/heads/main" }), ["owner/project", "refs/heads/main"]);
  assert.equal(source.targetLabel({ kind: "app", appId: 12 }), "App 12");
});
