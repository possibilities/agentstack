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

const { workerAccountLabels, providerTitle, relativeTime, untilTime, modelName, usageRows, catalogIdentity, catalogRows, splitArgs, inferErrorText, inferAdmission } = await import("../lib/stack/derive.ts");

const bot = (id, linkedAccounts = []) => ({ id, enabled: true, removing: false, linkedAccounts });
const worker = (id, provider, extra = {}) => ({ id, provider, enabled: true, ready: true, removing: false, linkedAccounts: [], ...extra });

test("workerAccountLabels numbers densely per provider in list order", () => {
  const labels = workerAccountLabels([
    worker("a", "codex"), worker("b", "grok"), worker("c", "codex"), worker("d", "devin"), worker("g", "claude"), worker("e", "grok"), worker("f", "codex"), worker("h", "claude", { enabled: false, ready: false }),
  ]);
  assert.deepEqual(Object.fromEntries(labels), { a: "codex-worker-account-1", b: "grok-worker-account-1", c: "codex-worker-account-2", d: "devin-worker-account-1", g: "claude-worker-account-1", e: "grok-worker-account-2", f: "codex-worker-account-3", h: "claude-worker-account-2" });
  assert.deepEqual(workerAccountLabels(null), new Map());
  assert.deepEqual(workerAccountLabels([]), new Map());
});

test("providerTitle names each worker provider", () => {
  assert.equal(providerTitle("codex"), "Codex");
  assert.equal(providerTitle("grok"), "Grok");
  assert.equal(providerTitle("devin"), "Devin");
  assert.equal(providerTitle("claude"), "Claude");
});

test("untilTime counts down to a future instant", () => {
  const now = 1_000_000_000;
  assert.equal(untilTime(null, now), "unknown");
  assert.equal(untilTime(now - 5_000, now), "now");
  assert.equal(untilTime(now + 12 * 60_000, now), "in 12m");
  assert.equal(untilTime(now + 5 * 3_600_000, now), "in 5h");
  assert.equal(untilTime(now + 5 * 86_400_000, now), "in 5d");
  assert.equal(untilTime(now + 40 * 3_600_000, now), "in 1d 16h");
  assert.equal(untilTime(now + 47 * 3_600_000, now), "in 1d 23h");
  assert.equal(untilTime(now + 90 * 60_000, now), "in 1h 30m");
});

test("time labels split calendar years and months before days, hours, and minutes", () => {
  const date = (value) => Date.parse(value);
  const start = date("2024-01-31T12:00:00Z");
  assert.equal(untilTime(date("2024-02-29T12:00:00Z"), start), "in 1mo");
  assert.equal(untilTime(date("2024-03-01T16:00:00Z"), start), "in 1mo 1d");
  assert.equal(untilTime(date("2025-03-31T12:00:00Z"), start), "in 1y 2mo");
  assert.equal(relativeTime(start, date("2024-02-29T12:00:00Z")), "1mo ago");
  assert.equal(relativeTime(start, date("2024-02-02T04:00:00Z")), "1d 16h ago");
  assert.equal(relativeTime(start, date("2024-01-31T13:30:00Z")), "1h 30m ago");
  assert.equal(relativeTime(start, start + 10_000), "10s ago");
  assert.equal(relativeTime(null, start), "never");
});

test("modelName drops a routing prefix", () => {
  assert.equal(modelName("openai/GPT-5.5"), "GPT-5.5");
  assert.equal(modelName("Claude Opus 5.5"), "Claude Opus 5.5");
});

test("usageRows folds a linked Codex Worker into its observed Bot", () => {
  const row = (scope, id, links, usage = { planType: "pro" }) => ({ scope, id, linkedAccounts: links, usage });
  const worker1 = row("worker", "w1", [{ scope: "bot", id: "b1" }], { planType: "plus" });
  const bot1 = row("bot", "b1", [{ scope: "worker", id: "w1" }]);
  const bot2 = row("bot", "b2", [{ scope: "worker", id: "w2" }], null);
  const worker2 = row("worker", "w2", [{ scope: "bot", id: "b2" }]);
  const bot3 = row("bot", "b3", [{ scope: "worker", id: "w3" }], null);
  const worker3 = row("worker", "w3", [{ scope: "bot", id: "b3" }], null);
  const grok = row("worker", "g1", []);
  // Different measurements still fold, and the Bot leads even when listed second.
  // An unobserved Bot does not hide its observed Worker.
  assert.deepEqual(usageRows([worker1, bot1, bot2, worker2, bot3, worker3, grok]).map((items) => items.map((item) => item.id)),
    [["b1", "w1"], ["b2"], ["w2"], ["b3", "w3"], ["g1"]]);
});

test("catalogRows stacks accounts with identical catalogs and keeps unobserved accounts apart", () => {
  const models = [{ id: "m1", name: "Model 1", efforts: ["low"], effortConfigId: null }];
  const catalog = (accountId, extra = {}) => ({ accountId, provider: "codex", observedAt: `2026-09-26T00:00:0${accountId.length}Z`, source: "acp", runtimeVersion: "1",
    modelConfigId: "model", models, nativeModelIds: [], stale: false, error: null, ...extra });
  const state = (catalog, extra = {}) => ({ catalog, stale: false, error: null, unavailable: null, ...extra });
  const identities = {
    a: catalogIdentity(state(catalog("a"))),
    b: catalogIdentity(state(catalog("bb", { models: [...models, { id: "m2", name: "Model 2", efforts: [], effortConfigId: null }] }))),
    c: catalogIdentity(state(catalog("ccc"))),
    d: catalogIdentity(state(catalog("dddd"), { stale: true })),
    e: null,
    f: null,
    g: catalogIdentity(state(catalog("ggggggg", { provider: "grok" }))),
  };
  // Account ID and observation time are not part of the identity; status and provider are.
  assert.equal(identities.a, identities.c);
  assert.deepEqual(catalogRows(Object.keys(identities), (id) => identities[id]), [["a", "c"], ["b"], ["d"], ["e"], ["f"], ["g"]]);
});

test("splitArgs reads a command line: whitespace separates, quotes group, backslash escapes", () => {
  assert.deepEqual(splitArgs(""), []);
  assert.deepEqual(splitArgs("  -c   key=value "), ["-c", "key=value"]);
  assert.deepEqual(splitArgs(`-c 'a b' "c \\"d\\"" e\\ f ''`), ["-c", "a b", 'c "d"', "e f", ""]);
  assert.equal(splitArgs(`-c "open`), null);
  assert.equal(splitArgs("-c 'open"), null);
});

test("infer codes explain ledger outcomes and separate refused admission from unconfirmed admission", () => {
  const requestId = "00000000-0000-4000-8000-000000000042";
  assert.match(inferErrorText(`infer_outcome_unknown:${requestId}`), /may have been charged and was not retried/);
  assert.match(inferErrorText("infer_interrupted"), /may have been charged/);
  assert.match(inferErrorText(`infer_output_budget_exceeded:${requestId}`), /not a spending cap/);
  assert.equal(inferErrorText("infer_http_error:502"), "The Codex backend answered HTTP 502.");
  assert.equal(inferErrorText("novel_code"), "novel_code");
  assert.deepEqual(inferAdmission("infer_busy"), { text: inferErrorText("infer_busy"), uncertain: false });
  // A lost acknowledgement is resent with the same request ID, which the ledger deduplicates.
  for (const message of ["connection closed", "socket call timed out: tools/call"]) {
    const admission = inferAdmission(message);
    assert.equal(admission.uncertain, true);
    assert.match(admission.text, /same request ID/);
  }
});
