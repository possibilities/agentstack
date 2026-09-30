import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { extname } from "node:path";
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

const { afterReceiptRead, applyInput, clearRecovery, continueInventory, continueSubscriptions, groupByOwner, linkNeedsSelection, loadInventory, loadSubscriptions,
  localOperation, measured, planReadiness, readRecovery, relationshipNode, saveRecovery, StateFlowController, stateOperations } = await import("../lib/stack/state.ts");

const entry = (id, owner, extra = {}) => ({ id, ownerPackage: owner, subject: null, kind: "storage", authority: "authoritative", location: "server", ownership: "stack",
  revision: null, observedAt: "2026-09-30T00:00:00.000Z", coverage: "partial", items: null, bytes: null, sensitivity: "content", relationships: [], reads: [], actions: [],
  retention: "Kept", regeneration: "None", issues: [], ...extra });
const plan = (extra = {}) => ({ id: "11111111-1111-4111-8111-111111111111", ownerPackage: "infer", subject: null, action: "history_clear", revision: "rev-1",
  createdAt: "2026-09-30T00:00:00.000Z", expiresAt: "2026-09-30T01:00:00.000Z", resources: ["request a"], blockedBy: [], retained: [], regeneration: [], ...extra });
const receipt = (status) => ({ requestId: "22222222-2222-4222-8222-222222222222", planId: plan().id, ownerPackage: "infer", subject: null, action: "history_clear",
  status, startedAt: "2026-09-30T00:10:00.000Z", completedAt: null, outcomes: [], retained: [], regeneration: [] });

/** A serve_state_list stand-in: two pages per observation; the revision changes when `observation` does. */
function inventoryOwner() {
  const owner = { observation: 1, calls: [] };
  owner.call = async (name, args) => {
    owner.calls.push([name, args]);
    const revision = `r${owner.observation}`;
    if (args.revision && args.revision !== revision) throw new Error("aggregate inventory changed; restart paging");
    const all = [entry(`bots:a${owner.observation}`, "bots", { bytes: 10 }), entry("bots:b", "bots"), entry("usage:c", "usage")];
    const page = all.slice(args.offset, args.offset + 2);
    return { entries: page, revision, observedAt: "2026-09-30T00:00:00.000Z", nextOffset: args.offset + 2 < all.length ? args.offset + 2 : null,
      owners: [{ package: "bots", available: true, issue: null }, { package: "usage", available: true, issue: null }, { package: "xcom", available: false, issue: "Owner unavailable" }] };
  };
  return owner;
}

test("inventory paging continues one observation and restarts from the first page when it changed", async () => {
  const owner = inventoryOwner();
  const first = await loadInventory(owner.call, { owners: null, measure: false });
  assert.deepEqual(owner.calls[0], ["serve_state_list", { measure: false, offset: 0, limit: 100 }], "no owners selection means every owner; measurement is explicit");
  assert.deepEqual(first.entries.map((row) => row.id), ["bots:a1", "bots:b"]);
  const all = await continueInventory(owner.call, first);
  assert.deepEqual(owner.calls[1][1], { measure: false, offset: 2, limit: 100, revision: "r1" }, "continuations pin the first page's revision");
  assert.deepEqual(all.entries.map((row) => row.id), ["bots:a1", "bots:b", "usage:c"]);
  assert.equal(all.restarted, false);
  assert.equal(await continueInventory(owner.call, all), all, "a complete observation is not re-read");

  // A stale continuation never mixes observations: it starts again at offset 0 and says so.
  owner.observation = 2;
  const restarted = await continueInventory(owner.call, first);
  assert.deepEqual(restarted.entries.map((row) => row.id), ["bots:a2", "bots:b"]);
  assert.equal(restarted.revision, "r2");
  assert.equal(restarted.restarted, true);

  // Owner selection and measurement are passed exactly; other failures are not treated as restarts.
  await loadInventory(owner.call, { owners: ["bots"], measure: true });
  assert.deepEqual(owner.calls.at(-1)[1], { owners: ["bots"], measure: true, offset: 0, limit: 100 });
  await assert.rejects(continueInventory(async () => { throw new Error("serve WebSocket is not connected"); }, first), /not connected/);
});

test("owners stay visible when unavailable or empty, and unmeasured is never zero", async () => {
  const inventory = await continueInventory(inventoryOwner().call, await loadInventory(inventoryOwner().call, { owners: null, measure: false }));
  const groups = groupByOwner(inventory);
  assert.deepEqual(groups.map((group) => [group.owner.package, group.owner.available, group.entries.length]), [["bots", true, 2], ["usage", true, 1], ["xcom", false, 0]]);
  assert.equal(measured(null, (value) => `${value} B`), "unmeasured");
  assert.equal(measured(0, (value) => `${value} B`), "0 B");
});

test("subscription paging passes exact filters and restarts on a changed observation", async () => {
  let revision = "s1";
  const calls = [];
  const call = async (name, args) => {
    calls.push(args);
    if (args.revision && args.revision !== revision) throw new Error("subscription observation changed; restart paging");
    return { subscriptions: [{ id: `sub-${args.offset}` }], revision, nextOffset: args.offset === 0 ? 1 : null };
  };
  const first = await loadSubscriptions(call, { botId: "alpha", threadId: "", package: undefined });
  assert.deepEqual(calls[0], { botId: "alpha", offset: 0, limit: 100 }, "empty filters are omitted rather than matched literally");
  assert.deepEqual((await continueSubscriptions(call, first)).subscriptions.map((row) => row.id), ["sub-0", "sub-1"]);
  revision = "s2";
  const again = await continueSubscriptions(call, first);
  assert.equal(again.restarted, true);
  assert.deepEqual(again.subscriptions.map((row) => row.id), ["sub-0"]);
});

test("state operations are local-only and follow the live WebSocket selection", () => {
  const catalog = { data: [{ name: "serve", transports: [{ type: "mcp", operations: ["serve_status"] }, { type: "websocket", operations: ["serve_state_list"] }] }] };
  assert.deepEqual(localOperation({ catalog }, "serve", "serve_state_list"), { available: true });
  assert.equal(localOperation({ catalog, remote: { scope: "control" } }, "serve", "serve_state_list").available, false, "remote Access never gets state controls");
  assert.match(localOperation({ catalog }, "serve", "serve_subscription_remove").reason, /does not expose serve_subscription_remove/);
  assert.match(localOperation({ catalog }, "bots", "bots_state_read").reason, /not in API discovery/);
  assert.match(localOperation({ catalog: { data: null } }, "serve", "serve_state_list").reason, /discovery/);
});

test("inventory links with empty arguments are drill-downs, and relationships link only known records", () => {
  assert.equal(linkNeedsSelection({ package: "bots", operation: "bot_state_plan", arguments: {} }), true);
  assert.equal(linkNeedsSelection({ package: "bots", operation: "bot_state_read", arguments: { botId: "a" } }), false);
  assert.deepEqual(relationshipNode({ relation: "automatic-input", package: "serve", kind: "subscription", id: "s" }), { kind: "subscription", id: "s" });
  assert.deepEqual(relationshipNode({ relation: "writer", package: "proc", kind: "run", id: "r" }), { kind: "proc-run", id: "r" });
  assert.equal(relationshipNode({ relation: "x", package: "hud", kind: "focus", id: "f" }), null);
});

test("blocked and expired plans cannot apply, and apply input binds the plan revision and owner identity", () => {
  const now = Date.parse("2026-09-30T00:30:00.000Z");
  assert.deepEqual(planReadiness(plan(), now), { canApply: true, blocked: false, expired: false, reason: null });
  const blocked = planReadiness(plan({ blockedBy: ["Stop Bot alpha"] }), now);
  assert.equal(blocked.canApply, false);
  assert.match(blocked.reason, /blocker/);
  const expired = planReadiness(plan(), Date.parse("2026-09-30T01:00:00.000Z"));
  assert.equal(expired.canApply, false);
  assert.match(expired.reason, /expired/);
  assert.deepEqual(applyInput(plan(), "req", { botId: "alpha" }), { planId: plan().id, expectedRevision: "rev-1", requestId: "req", botId: "alpha" });
});

test("a lost apply keeps its request: a receipt resolves it, an absent receipt stays uncertain", () => {
  const input = applyInput(plan(), "22222222-2222-4222-8222-222222222222");
  const checking = { phase: "checking", plan: plan(), input, error: "connection closed" };
  const found = afterReceiptRead(checking, receipt("partial"));
  assert.equal(found.phase, "receipt");
  assert.equal(found.receipt.status, "partial", "partial is presented as-is, never retried or replanned");
  const absent = afterReceiptRead(checking, null);
  assert.equal(absent.phase, "uncertain");
  assert.equal(absent.input, input, "the identical input is kept for an explicit same-UUID retry");
  assert.match(absent.error, /connection closed\. The owner has no receipt for this request ID\./);
  assert.match(afterReceiptRead(checking, null, "bots WebSocket is not connected").error, /Receipt read failed: bots WebSocket/);
});

test("reload recovery keeps only identity strings", () => {
  const values = new Map();
  globalThis.localStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
  try {
    const input = applyInput(plan(), "req-1", { botId: "alpha" });
    saveRecovery("bots:alpha:workspace", input);
    assert.deepEqual(readRecovery("bots:alpha:workspace").input, input);
    assert.deepEqual(Object.keys(JSON.parse(values.get("stack.state-flow.bots:alpha:workspace")).input).sort(), ["botId", "expectedRevision", "planId", "requestId"]);
    values.set("stack.state-flow.bad", JSON.stringify({ input: { planId: "p", expectedRevision: "r", requestId: "q", body: { secret: 1 } } }));
    assert.equal(readRecovery("bad"), null, "anything but identity strings is refused");
    clearRecovery("bots:alpha:workspace");
    assert.equal(readRecovery("bots:alpha:workspace"), null);
  } finally { delete globalThis.localStorage; }
});

test("owner callbacks call exactly the named operations of one owner", async () => {
  const calls = [];
  const ops = stateOperations(async (pkg, name, args) => { calls.push([pkg, name, args]); return name.endsWith("receipt_get") ? { receipt: null } : {}; },
    "infer", { plan: "infer_history_plan", apply: "infer_history_clear", receipt: "infer_state_receipt_get" }, { requestIds: ["a"] });
  await ops.prepare();
  await ops.apply({ planId: "p", expectedRevision: "r", requestId: "q" });
  assert.equal(await ops.readReceipt("q"), null);
  assert.deepEqual(calls, [["infer", "infer_history_plan", { requestIds: ["a"] }], ["infer", "infer_history_clear", { planId: "p", expectedRevision: "r", requestId: "q" }],
    ["infer", "infer_state_receipt_get", { requestId: "q" }]]);
});

/** A scripted owner: each call takes the next scripted answer (a value, an Error to throw, or a function of the input). */
function scriptedOwner(script) {
  const calls = [];
  const next = async (kind, input) => {
    calls.push([kind, input]);
    const answer = script[kind].shift();
    if (answer instanceof Error) throw answer;
    return typeof answer === "function" ? answer(input) : answer;
  };
  return { calls, operations: { prepare: () => next("prepare"), apply: (input) => next("apply", input), readReceipt: (requestId) => next("receipt", requestId) } };
}
const fakeStorage = () => {
  const values = new Map();
  globalThis.localStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
  return values;
};
const clock = (now = Date.parse("2026-09-30T00:30:00.000Z")) => {
  let n = 0;
  return { now: () => now, uuid: () => `00000000-0000-4000-8000-00000000000${++n}` };
};

test("the flow refuses blocked and expired plans without calling apply", async () => {
  for (const [label, prepared, now] of [["blocked", plan({ blockedBy: ["Stop Bot alpha first"] }), undefined], ["expired", plan(), Date.parse("2026-09-30T02:00:00.000Z")]]) {
    const owner = scriptedOwner({ prepare: [prepared], apply: [], receipt: [] });
    const flow = new StateFlowController({ operations: owner.operations }, clock(now));
    await flow.prepare();
    assert.equal(flow.getState().phase, "preview", label);
    await flow.apply();
    assert.equal(flow.getState().phase, "preview", `${label} plans stay in preview`);
    assert.deepEqual(owner.calls.map(([kind]) => kind), ["prepare"], `${label} plans never reach apply`);
  }
});

test("a lost apply reads its receipt, stays uncertain without one, and retries only the identical input", async () => {
  const values = fakeStorage();
  try {
    const answered = { ...receipt("completed"), requestId: "00000000-0000-4000-8000-000000000001" };
    const owner = scriptedOwner({ prepare: [plan()], apply: [new Error("connection closed"), (input) => ({ ...answered, requestId: input.requestId })], receipt: [null] });
    const receipts = [];
    const flow = new StateFlowController({ operations: owner.operations, extra: { botId: "alpha" }, recoveryKey: "bots:alpha:workspace", onReceipt: (value) => receipts.push(value) }, clock());
    await flow.prepare();
    await flow.apply();
    let state = flow.getState();
    assert.equal(state.phase, "uncertain");
    assert.match(state.error, /connection closed.*no receipt/);
    assert.deepEqual(state.input, { planId: plan().id, expectedRevision: "rev-1", requestId: "00000000-0000-4000-8000-000000000001", botId: "alpha" });
    assert.ok(values.has("stack.state-flow.bots:alpha:workspace"), "the uncertain request survives a reload");

    await flow.retry();
    state = flow.getState();
    assert.equal(state.phase, "receipt");
    const [first, second] = owner.calls.filter(([kind]) => kind === "apply").map(([, input]) => input);
    assert.deepEqual(second, first, "the retry is the identical input under the same request UUID");
    assert.deepEqual(owner.calls.filter(([kind]) => kind === "prepare").length, 1, "no automatic replan");
    assert.equal(receipts.length, 1);
    assert.equal(values.has("stack.state-flow.bots:alpha:workspace"), false, "a completed receipt needs no recovery");
  } finally { delete globalThis.localStorage; }
});

test("a running receipt is observed again; partial and unknown results stay recoverable until the operator leaves them", async () => {
  const values = fakeStorage();
  try {
    const owner = scriptedOwner({ prepare: [plan()], apply: [(input) => ({ ...receipt("running"), requestId: input.requestId })],
      receipt: [(requestId) => ({ ...receipt("partial"), requestId, outcomes: [{ resource: "request a", outcome: "unknown", detail: "Interrupted" }] })] });
    const flow = new StateFlowController({ operations: owner.operations, recoveryKey: "infer:history" }, clock());
    await flow.prepare();
    await flow.apply();
    assert.equal(flow.getState().receipt.status, "running");
    await flow.observe();
    const state = flow.getState();
    assert.equal(state.receipt.status, "partial");
    assert.deepEqual(owner.calls.at(-1), ["receipt", state.input.requestId], "observation reads the same request's receipt");
    assert.ok(values.has("stack.state-flow.infer:history"), "partial stays recoverable");
    await flow.observe();
    assert.equal(owner.calls.length, 3, "a settled receipt is not read again on invalidation");
    flow.reset();
    assert.equal(values.has("stack.state-flow.infer:history"), false);
  } finally { delete globalThis.localStorage; }
});

test("after a reload the saved request is read back rather than re-sent", async () => {
  fakeStorage();
  try {
    saveRecovery("xcom:posts", { planId: plan().id, expectedRevision: "rev-1", requestId: "00000000-0000-4000-8000-00000000000a" });
    const owner = scriptedOwner({ prepare: [], apply: [], receipt: [(requestId) => ({ ...receipt("unknown"), requestId })] });
    const flow = new StateFlowController({ operations: owner.operations, recoveryKey: "xcom:posts" }, clock());
    await flow.recover();
    assert.equal(flow.getState().phase, "receipt");
    assert.equal(flow.getState().receipt.status, "unknown");
    assert.deepEqual(owner.calls, [["receipt", "00000000-0000-4000-8000-00000000000a"]]);
  } finally { delete globalThis.localStorage; }
});

test("a detached view ignores late answers, and a newer decision supersedes an older one", async () => {
  const gate = Promise.withResolvers();
  const owner = scriptedOwner({ prepare: [() => gate.promise.then(() => plan({ action: "old" })), plan({ action: "new" })], apply: [], receipt: [] });
  const flow = new StateFlowController({ operations: owner.operations }, clock());
  const old = flow.prepare();
  await flow.prepare();
  gate.resolve();
  await old;
  assert.equal(flow.getState().plan.action, "new");
});
