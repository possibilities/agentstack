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

const { workerAccountLabels, accountLinks, providerTitle } = await import("../lib/stack/derive.ts");

const bot = (id, linkedAccounts = []) => ({ id, enabled: true, removing: false, linkedAccounts });
const worker = (id, provider, extra = {}) => ({ id, provider, enabled: true, ready: true, removing: false, linkedAccounts: [], ...extra });

test("workerAccountLabels numbers densely per provider in list order", () => {
  const labels = workerAccountLabels([
    worker("a", "codex"), worker("b", "grok"), worker("c", "codex"), worker("d", "devin"), worker("e", "grok"), worker("f", "codex"),
  ]);
  assert.deepEqual(Object.fromEntries(labels), { a: "codex-w1", b: "grok-1", c: "codex-w2", d: "devin-1", e: "grok-2", f: "codex-w3" });
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
