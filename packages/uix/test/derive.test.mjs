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

const { workerAccountLabels, accountLinks, providerTitle, untilTime, modelName, usageRows } = await import("../lib/stack/derive.ts");

const bot = (id, linkedAccounts = []) => ({ id, enabled: true, removing: false, linkedAccounts });
const worker = (id, provider, extra = {}) => ({ id, provider, enabled: true, ready: true, removing: false, linkedAccounts: [], ...extra });

test("workerAccountLabels numbers densely per provider in list order", () => {
  const labels = workerAccountLabels([
    worker("a", "codex"), worker("b", "grok"), worker("c", "codex"), worker("d", "devin"), worker("e", "grok"), worker("f", "codex"),
  ]);
  assert.deepEqual(Object.fromEntries(labels), { a: "codex-worker-account-1", b: "grok-worker-account-1", c: "codex-worker-account-2", d: "devin-worker-account-1", e: "grok-worker-account-2", f: "codex-worker-account-3" });
  assert.deepEqual(workerAccountLabels(null), new Map());
  assert.deepEqual(workerAccountLabels([]), new Map());
});

test("providerTitle names each worker provider", () => {
  assert.equal(providerTitle("codex"), "Codex");
  assert.equal(providerTitle("grok"), "Grok");
  assert.equal(providerTitle("devin"), "Devin");
});

test("accountLinks derives bot→worker pairs from the bot side only", () => {
  const workers = [worker("w1", "codex"), worker("w2", "codex"), worker("w3", "grok")];
  const accounts = [
    bot("b1", [{ scope: "worker", id: "w1" }, { scope: "worker", id: "w3" }]),
    bot("b2", [{ scope: "bot", id: "b1" }]),
    bot("b3"),
  ];
  assert.deepEqual(accountLinks(accounts, workers), [{ bot: "b1", worker: "w1" }, { bot: "b1", worker: "w3" }]);
});

test("accountLinks ignores links to missing workers and worker-side-only links", () => {
  // A bot link to a worker that is gone, plus a worker that links back but whose bot does not.
  const workers = [worker("w1", "codex", { linkedAccounts: [{ scope: "bot", id: "b1" }] })];
  const accounts = [bot("b1", [{ scope: "worker", id: "gone" }]), bot("b2")];
  assert.deepEqual(accountLinks(accounts, workers), []);
  assert.deepEqual(accountLinks(accounts, null), []);
  assert.deepEqual(accountLinks(null, workers), []);
});

test("accountLinks survives a worker ID equal to a bot account ID", () => {
  const workers = [worker("same-id", "codex")];
  const accounts = [bot("same-id", [{ scope: "worker", id: "same-id" }]), bot("other")];
  assert.deepEqual(accountLinks(accounts, workers), [{ bot: "same-id", worker: "same-id" }]);
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

test("usageRows merges linked accounts only when their observations match", () => {
  const usage = { planType: "pro" };
  const row = (scope, id, links, extra = {}) => ({ scope, id, linkedAccounts: links, usage, error: null, fresh: true, ...extra });
  const bot1 = row("bot", "b1", [{ scope: "worker", id: "w1" }]);
  const worker1 = row("worker", "w1", [{ scope: "bot", id: "b1" }]);
  const bot2 = row("bot", "b2", [{ scope: "worker", id: "w2" }]);
  const worker2 = row("worker", "w2", [{ scope: "bot", id: "b2" }], { usage: { planType: "plus" } });
  const grok = row("worker", "g1", []);
  assert.deepEqual(usageRows([bot1, worker1, bot2, worker2, grok]).map((items) => items.map((item) => item.id)), [["b1", "w1"], ["b2"], ["w2"], ["g1"]]);
});
