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

const { workerAccountLabels, providerTitle, untilTime, modelName, usageRows, catalogIdentity, catalogRows } = await import("../lib/stack/derive.ts");

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
