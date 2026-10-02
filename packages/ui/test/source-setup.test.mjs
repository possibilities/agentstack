import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { extname } from "node:path";
import test from "node:test";

registerHooks({ resolve(specifier, context, next) {
  return next(context.parentURL?.includes("/lib/stack/") && specifier.startsWith("./") && !extname(specifier) ? `${specifier}.ts` : specifier, context);
} });
const setup = await import("../lib/stack/source-setup.ts");

const id = "11111111-1111-4111-8111-111111111111";
const endpointId = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";
const endpoint = (extra = {}) => ({ id: endpointId, label: "Product", target: { kind: "repository", repository: "owner/project" }, githubHost: "github.com", publicOrigin: "https://hooks.example.com",
  path: `/github/webhooks/${endpointId}`, webhookUrl: `https://hooks.example.com/github/webhooks/${endpointId}`, enabled: true, revision: 3, secretVersion: 1, previousSecretExpiresAt: null,
  createdAt: "2026-10-01T10:00:00.000Z", updatedAt: "2026-10-01T10:00:00.000Z", lastDeliveryAt: null, lastPingAt: null, accepted: 0, duplicates: 0, rejected: 0, lastFailure: null, managedHookId: null, boundTargetId: null, ...extra });
const draft = (extra = {}) => ({ id, label: "  Product repository ", target: { ...setup.emptyTargetDraft, kind: "repository", repository: "owner/project" }, githubHost: "", publicOrigin: "", ...extra });

test("a receiver draft freezes into the exact request: trimmed, defaulted and validated like the owner", () => {
  const result = setup.freezeReceiver(draft({ publicOrigin: " https://Hooks.Example.com/ " }), 3);
  assert.equal(result.ok, true);
  assert.deepEqual(result.frozen.input, { id, label: "Product repository", target: { kind: "repository", repository: "owner/project" }, githubHost: "github.com", publicOrigin: "https://hooks.example.com" });
  assert.deepEqual(JSON.parse(result.frozen.json), result.frozen.input, "what is shown is what is sent");
  assert.equal(Object.isFrozen(result.frozen.input), true);
  assert.deepEqual(result.notes, [], "an automated target with an origin carries no caution");
  const unset = setup.freezeReceiver(draft(), null);
  assert.equal(unset.frozen.input.publicOrigin, null, "an omitted origin stays unset rather than becoming an empty string");
  assert.match(unset.notes.join(" "), /No public origin/);
  for (const [bad, pattern] of [[{ label: "   " }, /label/], [{ publicOrigin: "http://hooks.example.com" }, /https/], [{ publicOrigin: "https://hooks.example.com/path" }, /no path/],
    [{ publicOrigin: "https://user:pw@hooks.example.com" }, /credentials/], [{ publicOrigin: "https://127.0.0.1" }, /loopback/], [{ githubHost: "bad host" }, /hostname/],
    [{ target: { ...setup.emptyTargetDraft, kind: "repository", repository: "just-a-name" } }, /owner\/name/], [{ id: "nope" }, /UUID/]]) {
    const refused = setup.freezeReceiver(draft(bad), 0);
    assert.equal(refused.ok, false, JSON.stringify(bad));
    assert.match(refused.errors.join(" "), pattern);
  }
  assert.equal(setup.freezeReceiver(draft(), 128).ok, false, "the owner keeps at most 128 receivers");
});

test("targets keep their own fields, and only repository and organization on github.com are set up through gh", () => {
  const target = (kind, extra) => setup.targetInput({ ...setup.emptyTargetDraft, kind, ...extra });
  assert.deepEqual(target("organization", { organization: "acme" }).value, { kind: "organization", organization: "acme" });
  assert.deepEqual(target("app", { appId: " 42 " }).value, { kind: "app", appId: 42 });
  assert.deepEqual(target("app", {}).value, { kind: "app" }, "an App without an ID is any installation");
  assert.equal(target("app", { appId: "4x" }).ok, false);
  assert.deepEqual(target("sponsors_listing", { account: "octo" }).value, { kind: "sponsors_listing", account: "octo" });
  assert.equal(target("marketplace", {}).ok, true);
  assert.deepEqual(setup.setupMode({ kind: "repository", repository: "a/b" }, "GitHub.com"), { automated: true });
  assert.equal(setup.setupMode({ kind: "repository", repository: "a/b" }, "ghe.example.com").automated, false);
  assert.match(setup.setupMode({ kind: "repository", repository: "a/b" }, "ghe.example.com").reason, /Enterprise Server is set up by hand/);
  for (const kind of ["enterprise", "app", "marketplace", "sponsors_listing"]) assert.equal(setup.setupMode({ kind }, "github.com").automated, false, kind);
});

test("a creation whose answer was lost is read back by ID; a different target under that ID is a conflict, not success", () => {
  const input = setup.freezeReceiver(draft(), 0).frozen.input;
  assert.equal(setup.createOutcome(null, input), "absent");
  assert.equal(setup.createOutcome(endpoint({ id, label: "Renamed since" }), input), "created", "the label may have been edited since");
  assert.equal(setup.createOutcome(endpoint({ id, target: { kind: "organization", organization: "x" } }), input), "mismatch");
});

test("edits send only what changed, clear the origin as null, and never touch the immutable target", () => {
  const held = endpoint();
  assert.deepEqual(setup.editPatch(held, { label: " Product two " }), { ok: true, patch: { label: "Product two" } });
  assert.deepEqual(setup.editPatch(held, { label: " Product " }), { ok: true, patch: null }, "an unchanged label is not a write");
  assert.deepEqual(setup.editPatch(held, { publicOrigin: "" }), { ok: true, patch: { publicOrigin: null } });
  assert.deepEqual(setup.editPatch(held, { publicOrigin: "https://other.example.com" }), { ok: true, patch: { publicOrigin: "https://other.example.com" } });
  assert.deepEqual(setup.editPatch(held, { enabled: false }), { ok: true, patch: { enabled: false } });
  assert.equal(setup.editPatch(held, { publicOrigin: "ftp://x" }).ok, false);
  assert.equal(setup.editPatch(held, { label: "" }).ok, false);
});

test("rotation revokes immediately unless a grace period up to 24 hours is chosen", () => {
  assert.deepEqual(setup.rotateRequest({ mode: "immediate" }), { ok: true, graceSeconds: 0, words: "The old secret stops being accepted immediately." });
  assert.equal(setup.rotateRequest({ mode: "grace", amount: "30", unit: "minutes" }).graceSeconds, 1800);
  assert.equal(setup.rotateRequest({ mode: "grace", amount: "24", unit: "hours" }).graceSeconds, 86_400);
  assert.equal(setup.rotateRequest({ mode: "grace", amount: "90", unit: "seconds" }).graceSeconds, 90);
  assert.equal(setup.rotateRequest({ mode: "grace", amount: "25", unit: "hours" }).ok, false, "more than 24 hours is refused here, as at the owner");
  for (const amount of ["0", "", "1.5", "-3", "abc"]) assert.equal(setup.rotateRequest({ mode: "grace", amount, unit: "minutes" }).ok, false, amount);
  assert.equal(setup.graceWords(7200), "2 hours");
  assert.equal(setup.graceWords(90), "90 seconds");
  assert.equal(setup.graceWords(60), "1 minute");
});

test("hook events default to all, or an explicit list of valid names", () => {
  assert.deepEqual(setup.eventSelection("all", "ignored"), { ok: true, events: ["*"] });
  assert.deepEqual(setup.eventSelection("list", "issues, pull_request\nissues"), { ok: true, events: ["issues", "pull_request"] });
  assert.equal(setup.eventSelection("list", "").ok, false);
  assert.equal(setup.eventSelection("list", "Issues").ok, false);
  assert.equal(setup.eventSelection("list", "*").ok, false, "* is the all choice, never mixed into a list");
});

const plan = (extra = {}) => ({ id: "44444444-4444-4444-8444-444444444444", endpointId, endpointRevision: 3, action: "update", hookId: 17, webhookUrl: endpoint().webhookUrl, events: ["issues"],
  observedRevision: "abc", expiresAt: "2026-10-02T12:10:00.000Z", consequences: ["Configure only the exact hook"], ...extra });
const hook = (extra = {}) => ({ id: 17, active: false, events: ["push"], url: "https://old.example.com/hook", contentType: "form", insecureSsl: "1", updatedAt: null, ...extra });
const now = Date.parse("2026-10-02T12:00:00.000Z");

test("a plan review names the exact hook, every change at it, what stays untouched and when it expires", () => {
  const review = setup.planReview(plan(), [hook(), hook({ id: 8, url: "https://unrelated.example.com" })], endpoint(), now);
  assert.equal(review.headline, "Update webhook #17");
  assert.deepEqual(review.changes.map((change) => change.label), ["URL", "Events", "Active", "Content type", "TLS verification"]);
  assert.deepEqual(review.changes.find((change) => change.label === "Events"), { label: "Events", from: "push", to: "issues" });
  assert.equal(review.unrelated, 1, "hooks that are not the planned one are untouched");
  assert.equal(review.expired, false);
  assert.equal(review.msLeft, 600_000);
  assert.equal(setup.expiryWords(review.msLeft), "10:00 left");
  assert.equal(setup.planBlock(review), null);
  const create = setup.planReview(plan({ action: "create", hookId: null, events: ["*"] }), [hook()], endpoint(), now);
  assert.equal(create.headline, "Create a new webhook");
  assert.equal(create.eventsWords, "All events (*)");
  assert.deepEqual(create.changes, [], "a created hook has nothing to compare");
  assert.equal(create.unrelated, 1);
  assert.equal(setup.planReview(plan(), null, endpoint(), now).unrelated, null, "an unread inventory is not claimed to be empty");
  const same = setup.planReview(plan({ events: ["push"], webhookUrl: "https://old.example.com/hook" }), [hook({ active: true, contentType: "json", insecureSsl: "0" })], endpoint({ webhookUrl: "https://old.example.com/hook" }), now);
  assert.deepEqual(same.changes, [], "only differences are listed");
});

test("a plan that can no longer be applied says why before the owner refuses it", () => {
  assert.equal(setup.planReview(plan(), [], endpoint(), now + 600_000).expired, true);
  assert.equal(setup.expiryWords(0), "expired");
  assert.match(setup.planBlock(setup.planReview(plan(), [], endpoint(), now + 700_000)), /expired/);
  assert.match(setup.planBlock(setup.planReview(plan(), [], endpoint({ revision: 4 }), now)), /revision 3, now 4/);
  assert.match(setup.planBlock(setup.planReview(plan(), [], endpoint({ enabled: false }), now)), /disabled/);
  assert.match(setup.planBlock(setup.planReview(plan(), [], endpoint({ webhookUrl: "https://moved.example.com/x" }), now)), /not the one this plan sets/);
});

const receipt = (status, extra = {}) => ({ requestId, endpointId, action: "update", status, hookId: 17, startedAt: "2026-10-02T12:00:01.000Z", completedAt: status === "running" ? null : "2026-10-02T12:00:02.000Z", error: null, ...extra });
const entry = (extra = {}) => ({ requestId, endpointId, kind: "apply", at: now, intent: "Update webhook #17", status: "pending", planId: "44444444-4444-4444-8444-444444444444", hookId: 17, startedAt: null, completedAt: null, error: null, ...extra });

test("a request is recorded before it is sent, and a clear answer settles it with the owner's receipt", async () => {
  const kv = setup.memoryStorage();
  let recordedBeforeSend = null;
  const io = { dispatch: async (sent) => { recordedBeforeSend = setup.readJournal(kv, endpointId).find((held) => held.requestId === sent.requestId) ?? null; return receipt("succeeded"); }, readReceipt: async () => { throw new Error("not needed"); } };
  const outcome = await setup.sendRemote(kv, io, entry());
  assert.equal(recordedBeforeSend?.status, "pending", "the entry existed, unconfirmed, when the request went out");
  assert.equal(outcome.sent, true);
  assert.equal(outcome.entry.status, "succeeded");
  assert.equal(outcome.entry.startedAt, "2026-10-02T12:00:01.000Z");
  assert.equal(setup.readJournal(kv, endpointId)[0].status, "succeeded");
});

test("a lost answer is resolved by reading the receipt for the same request ID, never by sending again", async () => {
  const kv = setup.memoryStorage();
  const dispatched = [], read = [];
  const io = { dispatch: async (sent) => { dispatched.push(sent.requestId); throw new Error("connection lost"); }, readReceipt: async (reqId) => { read.push(reqId); return receipt("succeeded"); } };
  const outcome = await setup.sendRemote(kv, io, entry());
  assert.deepEqual(dispatched, [requestId], "one dispatch");
  assert.deepEqual(read, [requestId], "the receipt is read under the same ID");
  assert.equal(outcome.entry.status, "succeeded");
  assert.equal(outcome.error, "connection lost");
  // The owner never recorded it: it never reached GitHub, and the only way to send it again is with its own ID.
  const kv2 = setup.memoryStorage();
  const none = await setup.sendRemote(kv2, { dispatch: async () => { throw new Error("github_hook_plan_missing_or_expired"); }, readReceipt: async () => null }, entry());
  assert.equal(none.entry.status, "absent");
  assert.match(setup.entryWords(none.entry).text, /never reached GitHub/);
  assert.equal(setup.canSendAgain(none.entry), true);
  assert.deepEqual(setup.resendArguments(none.entry), { name: "github_hook_apply", args: { planId: entry().planId, requestId } }, "the same ID and the same plan");
  // A receipt that cannot be read leaves the request unconfirmed, with its ID kept.
  const kv3 = setup.memoryStorage();
  const stuck = await setup.sendRemote(kv3, { dispatch: async () => { throw new Error("socket closed"); }, readReceipt: async () => { throw new Error("socket still closed"); } }, entry());
  assert.equal(stuck.entry.status, "pending");
  assert.equal(stuck.readError, "socket still closed");
  assert.equal(setup.canSendAgain(stuck.entry), false, "an unconfirmed request may have reached GitHub");
  assert.equal(setup.canReadReceipt(stuck.entry), true);
  assert.equal(setup.readJournal(kv3, endpointId)[0].requestId, requestId);
});

test("unknown outcomes are never sent again, only read, and survive until forgotten", async () => {
  const kv = setup.memoryStorage();
  const outcome = await setup.sendRemote(kv, { dispatch: async () => receipt("unknown", { error: "github_gh_request_failed" }), readReceipt: async () => null }, entry());
  assert.equal(outcome.entry.status, "unknown");
  assert.equal(setup.canSendAgain(outcome.entry), false);
  assert.equal(setup.canReadReceipt(outcome.entry), true);
  assert.match(setup.entryWords(outcome.entry).text, /will not run again/);
  for (let index = 0; index < 20; index++) setup.begin(kv, entry({ requestId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, at: now + 1 + index, status: "succeeded" }));
  const kept = setup.readJournal(kv, endpointId);
  assert.ok(kept.some((held) => held.requestId === requestId), "an unsettled request is never trimmed away");
  assert.ok(kept.length <= 13, "settled history is bounded");
  setup.forget(kv, endpointId, requestId);
  assert.equal(setup.readJournal(kv, endpointId).some((held) => held.requestId === requestId), false);
});

test("a request that cannot be recorded is not sent", async () => {
  const kv = { get: () => null, set: () => false, remove: () => {} };
  let sent = 0;
  const outcome = await setup.sendRemote(kv, { dispatch: async () => { sent++; return receipt("succeeded"); }, readReceipt: async () => null }, entry());
  assert.equal(outcome.sent, false);
  assert.equal(sent, 0);
  assert.match(outcome.reason, /not sent/);
});

test("journals are per receiver and ignore anything that is not a recorded request", () => {
  const kv = setup.memoryStorage();
  const other = "55555555-5555-4555-8555-555555555555";
  setup.begin(kv, entry());
  setup.begin(kv, entry({ endpointId: other, requestId: "66666666-6666-4666-8666-666666666666" }));
  assert.equal(setup.readJournal(kv, endpointId).length, 1);
  assert.equal(setup.readJournal(kv, other).length, 1);
  kv.set(setup.journalKey(endpointId), JSON.stringify([{ requestId: "not-a-uuid" }, null, 5, entry({ status: "bogus" })]));
  assert.deepEqual(setup.readJournal(kv, endpointId), []);
  kv.set(setup.journalKey(endpointId), "{not json");
  assert.deepEqual(setup.readJournal(kv, endpointId), []);
  assert.ok(!JSON.stringify([...kv.entries.values()]).match(/secret/i), "nothing secret is ever recorded");
});

test("resending a probe or redelivery carries the recorded inputs and ID, and every kind says what it did and did not show", () => {
  assert.deepEqual(setup.resendArguments(entry({ kind: "ping", planId: undefined })), { name: "github_hook_probe", args: { endpointId, hookId: 17, requestId, action: "ping" } });
  assert.deepEqual(setup.resendArguments(entry({ kind: "test", planId: undefined })).args.action, "test");
  assert.deepEqual(setup.resendArguments(entry({ kind: "redeliver", planId: undefined, attemptId: 91 })), { name: "github_hook_redeliver", args: { endpointId, hookId: 17, deliveryId: 91, requestId } });
  assert.equal(setup.resendArguments(entry({ kind: "redeliver", planId: undefined })), null, "a redelivery without its exact attempt cannot be rebuilt");
  assert.match(setup.entryWords(entry({ kind: "apply", status: "succeeded" })).text, /not delivery verification/);
  assert.match(setup.entryWords(entry({ kind: "ping", status: "succeeded" })).text, /admission, not arrival/);
  assert.match(setup.entryWords(entry({ kind: "ping", status: "failed", error: "github_http_403" })).text, /did not take effect.*permission/);
  assert.equal(setup.errorWords("github_response_invalid"), "GitHub's answer was not understood.");
  assert.equal(setup.errorWords("odd_code"), "odd_code");
  assert.equal(setup.errorWords(null), null);
});

test("the request-receipt fact reports what the journal holds and keeps requests apart from arrivals", () => {
  assert.equal(setup.requestFact([], String).word, "None recorded");
  const fact = setup.requestFact([entry({ status: "succeeded", kind: "ping", at: 1 }), entry({ requestId: "77777777-7777-4777-8777-777777777777", status: "unknown", at: 2 })], (at) => `t${at}`);
  assert.equal(fact.word, "Outcome unknown", "the newest request leads");
  assert.equal(fact.tone, "warning");
  assert.match(fact.lines[0], /Hook configuration 77777777 · Outcome unknown · t2/);
  assert.match(fact.lines.at(-1), /a request is not an arrival/);
});

test("a probe's arrival is judged separately: observed since the request began, or not", () => {
  const ping = entry({ kind: "ping", startedAt: "2026-10-02T12:00:01.000Z" });
  assert.deepEqual(setup.probeArrival(ping, { lastPingAt: null, lastDeliveryAt: "2026-10-02T12:05:00.000Z" }), { observed: false, at: null, label: "signed ping" }, "another delivery is not the ping");
  assert.equal(setup.probeArrival(ping, { lastPingAt: "2026-10-02T11:00:00.000Z", lastDeliveryAt: null }).observed, false, "an older ping predates the request");
  assert.equal(setup.probeArrival(ping, { lastPingAt: "2026-10-02T12:00:09.000Z", lastDeliveryAt: null }).observed, true);
  const test = entry({ kind: "test", startedAt: "2026-10-02T12:00:01.000Z" });
  assert.deepEqual(setup.probeArrival(test, { lastPingAt: null, lastDeliveryAt: "2026-10-02T12:00:09.000Z" }), { observed: true, at: "2026-10-02T12:00:09.000Z", label: "signed delivery" });
});

test("upstream attempts are matched to local arrivals by GUID and receiver, never by GitHub's attempt ID", () => {
  const attempts = [{ guid: "g-1" }, { guid: "g-2" }, { guid: "g-3" }];
  const local = [{ sequence: 41, deliveryId: "g-1", endpointId }, { sequence: 42, deliveryId: "g-2", endpointId: "other" }, { sequence: 43, deliveryId: "91", endpointId }];
  assert.deepEqual(setup.correlateAttempts(attempts, local, endpointId), { "g-1": 41 });
  assert.equal(setup.correlationStart(30, 500), 0);
  assert.equal(setup.correlationStart(1200, 500), 700);
});

test("hooks list the managed or URL-matching one first and call the rest untouched", () => {
  const ordered = setup.orderHooks([hook({ id: 8, url: "https://x" }), hook({ id: 17, url: "https://old" }), hook({ id: 9, url: endpoint().webhookUrl })], endpoint({ managedHookId: 17 }));
  assert.deepEqual(ordered.map((item) => [item.hook.id, item.role]), [[17, "managed"], [9, "matching"], [8, "other"]]);
});
