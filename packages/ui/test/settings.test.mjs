import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { extname } from "node:path";
import test from "node:test";

registerHooks({ resolve(specifier, context, next) {
  return next(context.parentURL?.includes("/lib/stack/") && specifier.startsWith("./") && !extname(specifier) ? `${specifier}.ts` : specifier, context);
} });
const { botChoices, buildPatch, conflictKeys, controlFor, describeEvidence, draftIssues, editRequest, parseInput, settleDraft, workerApplyBlock, workerChoices } = await import("../lib/stack/settings.ts");
const { StackStore } = await import("../lib/stack/store.ts");

const snapshot = (values, revision = 3) => ({ revision, values, source: "test", sourceRevision: null, updatedAt: 1 });
const id = "c34f83f2-1f43-46d1-854f-014fc40f9683";

test("a draft becomes the minimal patch, and the three prompt-clear meanings stay distinct", () => {
  const saved = snapshot({ model: "sol", "voice.prompt": "Hi", web_search: "live" });
  const { patch, invalid } = buildPatch({
    model: { kind: "set", value: "sol" },                // equal to saved: no-op
    web_search: { kind: "reset" },                      // removes an override
    service_tier: { kind: "reset" },                    // already omitted: no-op
    "voice.includeStartupContext": { kind: "set", value: false },
    "voice.prompt": { kind: "set", value: null },       // explicit native null, not removal
    model_context_window: { kind: "invalid", raw: "", error: "Enter a number" },
  }, saved, id);
  assert.deepEqual(patch, { expectedRevision: 3, requestId: id, set: { "voice.includeStartupContext": false, "voice.prompt": null }, reset: ["web_search"] });
  assert.deepEqual(invalid, ["model_context_window"]);
  assert.deepEqual(buildPatch({ "voice.prompt": { kind: "set", value: "" } }, saved, id).patch.set, { "voice.prompt": "" });
  assert.deepEqual(buildPatch({ "voice.prompt": { kind: "reset" } }, saved, id).patch.reset, ["voice.prompt"]);
  assert.deepEqual(buildPatch({}, saved, id).patch, { expectedRevision: 3, requestId: id });
});

test("Bot edits are flat and Worker edits nest target and patch; defaults omit the instance", () => {
  const patch = { expectedRevision: 7, requestId: id, set: { model_context_window: 120000 } };
  assert.deepEqual(editRequest({ kind: "bot", id: "bot-1" }, patch, "preview"), { pkg: "bots", name: "bot_settings_preview", args: { id: "bot-1", ...patch } });
  assert.deepEqual(editRequest({ kind: "bot-defaults" }, patch, "patch").args, patch);
  assert.deepEqual(editRequest({ kind: "worker-defaults", provider: "grok" }, patch, "patch"), { pkg: "worker", name: "worker_settings_patch", args: { target: { provider: "grok" }, patch } });
});

test("controls come from the catalog schema, and buffers never coerce emptiness into a value", () => {
  const number = controlFor({ type: "integer", exclusiveMinimum: 0, maximum: 9007199254740991 });
  assert.equal(parseInput(number, "").kind, "invalid", "an empty number is not zero");
  assert.equal(parseInput(number, "0").kind, "invalid");
  assert.equal(parseInput(number, "1.5").kind, "invalid");
  assert.deepEqual(parseInput(number, "120000"), { kind: "set", value: 120000 });
  const roots = controlFor({ type: "array", maxItems: 128, items: { type: "string", maxLength: 4096, pattern: "^\\/.*" } });
  assert.deepEqual(parseInput(roots, ""), { kind: "set", value: [] }, "an empty list is explicit, not unset");
  assert.equal(parseInput(roots, "relative/path").kind, "invalid");
  const prompt = controlFor({ anyOf: [{ type: "string", maxLength: 262144 }, { type: "null" }] });
  assert.equal(prompt.kind === "string" && prompt.nullable && prompt.multiline, true);
  assert.deepEqual(parseInput(prompt, "  keep  whitespace \n"), { kind: "set", value: "  keep  whitespace \n" });
  assert.equal(parseInput(controlFor({ type: "string", minLength: 1, maxLength: 1024 }), "").kind, "invalid");
  assert.deepEqual(controlFor({ type: "string", enum: ["low", "high"] }), { kind: "enum", values: ["low", "high"] });
});

test("evidence reads state first: native null, omission, unknown, false, empty string and empty list differ", () => {
  const texts = [
    { state: "known", value: null }, { state: "native", value: null }, { state: "unknown", value: null },
    { state: "known", value: false }, { state: "known", value: "" }, { state: "known", value: [] },
  ].map((evidence) => describeEvidence({ ...evidence, source: "s", observedAt: null }).text);
  assert.equal(new Set(texts).size, texts.length, texts.join(" | "));
  assert.equal(texts[2], "Not observed");
});

test("a settled save clears only what it carried; conflicts name keys another writer changed", () => {
  const attempted = { model: { kind: "set", value: "a" }, effort: { kind: "set", value: "high" } };
  const current = { ...attempted, effort: { kind: "set", value: "low" }, web_search: { kind: "reset" } };
  assert.deepEqual(settleDraft(current, attempted), { effort: { kind: "set", value: "low" }, web_search: { kind: "reset" } });
  assert.deepEqual(conflictKeys({ model: "a", effort: "x" }, { model: "b", effort: "x" }, { model: {}, effort: {} }), ["model"]);
  assert.deepEqual(conflictKeys({ model: "a" }, {}, { model: {} }), ["model"], "a removal is a change");
});

test("local issues explain server rules without rewriting values", () => {
  const saved = snapshot({ sandbox_mode: "read-only" });
  assert.match(draftIssues(saved, { default_permissions: { kind: "set", value: "strict" } })[0], /mutually exclusive/);
  assert.deepEqual(draftIssues(saved, { default_permissions: { kind: "set", value: "strict" }, sandbox_mode: { kind: "reset" } }), []);
  assert.match(draftIssues(snapshot({}), { "voice.prompt": { kind: "set", value: "x".repeat(130_000) } })[0], /limit is 128,000/);
});

test("native choices follow the draft's model, and Worker Apply requires the exact idle runtime", () => {
  const options = { instance: "i", observedAt: 1, voices: { available: false, data: null, issue: "x" }, features: { available: true, data: [], issue: null }, requirements: { available: true, data: null, issue: null },
    models: { available: true, issue: null, data: [
      { id: "m1", model: "sol", displayName: "Sol", isDefault: true, defaultReasoningEffort: "medium", supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "" }] },
      { id: "m2", model: "luna", displayName: "Luna", isDefault: false, defaultReasoningEffort: "low", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "" }, { reasoningEffort: "high", description: "" }] }] } };
  const effort = { key: "model_reasoning_effort", choices: "efforts", dependencies: ["model"] };
  assert.deepEqual(botChoices(effort, options, {}).map((choice) => choice.value), ["medium"], "unset model falls back to the native default model");
  assert.deepEqual(botChoices(effort, options, { model: "luna" }).map((choice) => choice.value), ["low", "high"]);
  assert.equal(botChoices({ key: "voice.voice", choices: "voices", dependencies: [] }, options, {}), null, "unavailable discovery cannot say, which differs from offering none");
  assert.equal(botChoices(effort, options, { model: "retired" }), null, "a model discovery does not know has unknown efforts");
  const catalog = { models: [{ id: "opus", name: "Opus", efforts: ["low", "max"] }] };
  assert.deepEqual(workerChoices({ choices: "efforts" }, catalog, {}, "opus").map((choice) => choice.value), ["low", "max"]);
  assert.deepEqual(workerChoices({ choices: "efforts" }, { models: [{ id: "haiku", name: "Haiku", efforts: [] }] }, { model: "haiku" }, null), [], "a known model with no efforts offers none");
  const view = { instance: "rt-1" };
  const idle = { phase: "idle", sessionId: "s", runtimeInstance: "rt-1" };
  assert.equal(workerApplyBlock(idle, view), null);
  assert.match(workerApplyBlock({ ...idle, phase: "running" }, view), /idle/);
  assert.match(workerApplyBlock({ ...idle, runtimeInstance: "rt-2" }, view), /another runtime/);
  assert.match(workerApplyBlock({ ...idle, phase: "closed" }, view), /no runtime/);
  assert.match(workerApplyBlock(null, view), /Reading/);
});

const resource = (data) => ({ data, error: null, at: 1 });
async function until(store, condition) {
  if (condition()) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error("store did not update")); }, 2000);
    const off = store.subscribe(() => { if (condition()) { clearTimeout(timer); off(); resolve(); } });
  });
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

function harness(handlers) {
  const original = globalThis.WebSocket;
  const sockets = new Set();
  const calls = [];
  const base = {
    account_list: () => ({ accounts: [] }), worker_account_list: () => ({ accounts: [] }),
    account_login_current: () => ({ login: null }), worker_account_login_current: () => ({ logins: [] }),
    worker_runtime_list: () => ({ runtimes: [] }), worker_list: () => ({ workers: [] }), worker_status: () => ({ worker: {}, turn: null, pending: [] }),
    bot_list: () => ({ bots: [] }), bot_defaults_get: () => ({}), voice_status: () => ({ call: null }),
    bot_settings_catalog: () => ({ settings: [] }), worker_settings_catalog: () => ({ settings: [] }),
  };
  class Socket {
    static CONNECTING = 0;
    static OPEN = 1;
    readyState = 0;
    subscriptions = new Map();
    constructor(url) { this.url = url; sockets.add(this); queueMicrotask(() => { this.readyState = 1; this.onopen?.(); }); }
    send(raw) {
      const { id, method, params } = JSON.parse(raw);
      if (method === "events/subscribe") this.subscriptions.set(params.subscription, params);
      else if (method === "events/unsubscribe") this.subscriptions.delete(params.subscription);
      else calls.push(params);
      void Promise.resolve().then(() => method.startsWith("events/") ? params : (handlers[params.name] ?? base[params.name])(params.arguments))
        .then((result) => this.onmessage?.({ data: JSON.stringify({ id, result }) }), (error) => this.onmessage?.({ data: JSON.stringify({ id, error: { message: error.message } }) }));
    }
    close() { this.readyState = 3; sockets.delete(this); this.onclose?.(); }
  }
  globalThis.WebSocket = Socket;
  const store = new StackStore({ server: resource(null), resources: resource(null), accounts: resource([]), workerAccounts: resource([]),
    workerRuntimes: resource([]), workerSessions: resource([]), login: resource(null), workerLogins: resource([]),
    bots: resource([]), botDefaults: resource({}), voice: resource(null), catalog: resource([]), usage: resource(null),
    endpoints: Object.fromEntries(["auth", "worker", "bots"].map((name) => [name, "ws://fixture.invalid/websocket"])) });
  const publish = (pkg, topic, scope) => {
    for (const socket of sockets) for (const subscription of socket.subscriptions.values())
      if (subscription.package === pkg && subscription.topics.includes(topic) && subscription.scope === scope)
        socket.onmessage?.({ data: JSON.stringify({ method: "events/changed", params: { package: pkg, subscription: subscription.subscription, topic } }) });
  };
  const count = (name, match = () => true) => calls.filter((call) => call.name === name && match(call.arguments)).length;
  return { store, calls, publish, count, restore: () => { store.stop(); globalThis.WebSocket = original; } };
}

test("watched settings views re-read on the notices that can change them, and only those", async () => {
  let revision = 1;
  const view = (args) => ({ backend: "codex-app-server", saved: snapshot({}, revision), defaults: null, loaded: null, instance: null, fields: [], issues: [], args });
  const { store, publish, count, restore } = harness({ bot_settings_read: view });
  try {
    store.start({ scopedBots: false });
    const off1 = store.watchSettings({ kind: "bot", id: "bot-1" });
    const offDefaults = store.watchSettings({ kind: "bot-defaults" });
    const offCatalog = store.watchSettingsCatalog("bots");
    await until(store, () => store.getState().settingsViews["bot:bot-1"]?.data && store.getState().settingsViews["bot-defaults"]?.data && store.getState().settingsCatalogs.bots?.data);
    assert.deepEqual(store.getState().settingsViews["bot:bot-1"].data.args, { id: "bot-1", observe: true });
    assert.deepEqual(store.getState().settingsViews["bot-defaults"].data.args, {}, "defaults reads omit the id");

    const before = { bot: count("bot_settings_read", (a) => a.id === "bot-1"), defaults: count("bot_settings_read", (a) => !a.id), catalog: count("bot_settings_catalog") };
    revision = 2;
    publish("bots", "defaults_changed");
    await until(store, () => store.getState().settingsViews["bot-defaults"].data.saved.revision === 2 && store.getState().settingsViews["bot:bot-1"].data.saved.revision === 2);
    await tick();
    assert.equal(count("bot_settings_catalog"), before.catalog + 1, "application defaults in the catalog follow the defaults document");

    const voiceBefore = { bot: count("bot_settings_read", (a) => a.id === "bot-1"), defaults: count("bot_settings_read", (a) => !a.id) };
    publish("bots", "voice_changed");
    await tick();
    assert.equal(count("bot_settings_read", (a) => a.id === "bot-1"), voiceBefore.bot + 1, "call-loaded voice evidence re-reads Bot views");
    assert.equal(count("bot_settings_read", (a) => !a.id), voiceBefore.defaults, "defaults have no call");

    off1();
    assert.equal(store.getState().settingsViews["bot:bot-1"], undefined, "an unwatched view is dropped");
    offDefaults();
    offCatalog();
  } finally { restore(); }
});

test("a settings write re-reads its target even when its acknowledgement is lost, and never replays it", async () => {
  let fail = true;
  const { store, count, restore } = harness({
    bot_settings_read: () => ({ backend: "codex-app-server", saved: snapshot({}), defaults: null, loaded: null, instance: null, fields: [], issues: [] }),
    bot_settings_patch: () => { if (fail) throw new Error("connection closed"); return { requestId: id, revision: 4, duplicate: true, applied: false }; },
  });
  try {
    store.start({ scopedBots: false });
    const off = store.watchSettings({ kind: "bot", id: "bot-1" });
    await until(store, () => store.getState().settingsViews["bot:bot-1"]?.data);
    const reads = count("bot_settings_read");
    const args = { id: "bot-1", expectedRevision: 3, requestId: id, set: { model: "sol" } };
    await assert.rejects(store.call("bots", "bot_settings_patch", args), /connection closed/);
    await until(store, () => count("bot_settings_read") > reads);
    assert.equal(count("bot_settings_patch"), 1, "the uncertain write is not replayed");
    fail = false;
    const receipt = await store.call("bots", "bot_settings_patch", args);
    assert.equal(receipt.duplicate, true, "an explicit retry reuses the same request ID and payload");
    off();
  } finally { restore(); }
});

test("streaming Worker progress coalesces settings reads into one follow-up", async () => {
  const worker = "1c35bfda-7f6d-4d9a-867b-5a26025e6876";
  const gates = [];
  const { store, publish, count, restore } = harness({
    worker_settings_read: () => new Promise((resolve) => gates.push(() => resolve({ backend: "claude-sdk", saved: snapshot({}), defaults: null, loaded: null, instance: "rt", fields: [], issues: [] }))),
  });
  try {
    store.start({ scopedBots: false });
    const off = store.watchSettings({ kind: "worker", id: worker });
    await until(store, () => gates.length >= 1);
    for (let i = 0; i < 20; i++) publish("worker", "worker_progress", worker);
    await tick();
    const inFlight = count("worker_settings_read", (a) => a.id === worker);
    while (gates.length) { gates.shift()(); await tick(); }
    await until(store, () => store.getState().settingsViews[`worker:${worker}`]?.data);
    assert.ok(count("worker_settings_read", (a) => a.id === worker) <= inFlight + 1, "a burst of notices yields at most one follow-up read");
    off();
    const after = count("worker_settings_read");
    publish("worker", "worker_progress", worker);
    await tick();
    assert.equal(count("worker_settings_read"), after, "an unwatched Worker is not re-read");
  } finally { restore(); }
});
