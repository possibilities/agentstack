import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { registerHooks } from "node:module";
import { extname } from "node:path";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.includes("/lib/stack/") && specifier.startsWith("./") && !extname(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const shims = await import("../lib/stack/shims.ts");
const { StackStore } = await import("../lib/stack/store.ts");

// Whitespace, both quote kinds, leading dashes, `#`, an empty argument and a native `--` after the harness.
const complex = ["default", "--with-harness", "opencode", "--with-model=astra", "--", "opencode", "run", "--model", "openai/gpt-6-astra#medium",
  "--yolo", "  padded  ", "it's \"quoted\"", "", "#comment", "$HOME `x` \\n", "--", "-dash prompt"];
const shim = (name, args, revision = "a".repeat(64)) => ({ name, args, path: `/home/me/.local/bin/${name}`, revision });

test("a vector splits at its first -- and joins back to exactly the same tokens", () => {
  const vector = shims.splitShimArgs(complex);
  assert.deepEqual(vector.stack, ["default", "--with-harness", "opencode", "--with-model=astra"]);
  assert.equal(vector.harness, "opencode");
  assert.equal(vector.native[0], "run");
  assert.ok(vector.native.includes("--"), "a later -- belongs to the native side");
  assert.deepEqual(shims.joinShimArgs(vector), complex);
  assert.equal(shims.shimArgsIssue(vector), null);
});

test("the preview is one shell word per argument, and a shell reads back the exact vector", () => {
  const command = shims.shimCommand(complex);
  assert.ok(command.startsWith("stack roles inject default --with-harness opencode "));
  assert.ok(command.endsWith(' "$@"'));
  assert.ok(command.includes("'openai/gpt-6-astra#medium'"), "# is quoted so no shell reads a comment");
  // Evaluate the rendered words in a real POSIX shell: what the page shows is exactly what the command receives.
  const words = complex.map(shims.shellWord).join(" ");
  const output = execFileSync("sh", ["-c", `set -- ${words}; for a in "$@"; do printf '%s\\0' "$a"; done`], { encoding: "utf8" });
  assert.deepEqual(output.split("\0").slice(0, -1), complex);
});

test("names and vectors mirror the API's refusals", () => {
  assert.equal(shims.shimNameIssue("opencode-astra"), null);
  assert.match(shims.shimNameIssue(""), /Name/);
  assert.match(shims.shimNameIssue("-x"), /Start with/);
  assert.match(shims.shimNameIssue("a/b"), /Start with/);
  assert.match(shims.shimNameIssue("x".repeat(101)), /100/);
  for (const reserved of ["stack", "claude", "codex", "opencode"]) assert.match(shims.shimNameIssue(reserved), /native harness/);
  assert.match(shims.shimNameIssue("mine", [shim("mine", ["--", "codex"])]), /already/);
  assert.match(shims.shimArgsIssue({ stack: ["default", "--"], harness: "codex", native: [] }), /boundary/);
  assert.match(shims.shimArgsIssue({ stack: [], harness: "", native: [] }), /Choose/);
  assert.match(shims.shimArgsIssue({ stack: [], harness: "bash", native: [] }), /Choose/);
  assert.match(shims.shimArgsIssue({ stack: [], harness: "codex", native: Array(127).fill("x") }), /128/);
  assert.match(shims.shimArgsIssue({ stack: [], harness: "codex", native: ["x".repeat(4_097)] }), /longer/);
  assert.match(shims.shimArgsIssue({ stack: [], harness: "codex", native: ["a\0b"] }), /NUL/);
  // No native-option allowlist: anything after the harness is kept for roles inject to judge at launch.
  assert.equal(shims.shimArgsIssue({ stack: [], harness: "opencode", native: ["--totally-new-flag", "--yolo"] }), null);
});

test("the Stack side is read for labels only, and Roles are named for when the command runs", () => {
  assert.deepEqual(shims.readStackArgs(["default", "--with-harness", "opencode", "--with-model", "astra"]),
    { role: "default", model: "astra", harness: "opencode", warnings: [] });
  assert.deepEqual(shims.readStackArgs([]).role, null);
  assert.deepEqual(shims.readStackArgs(["a", "b"]).warnings, ["Only one Role may be named; “b” is a second"]);
  assert.deepEqual(shims.readStackArgs(["--with-model"]).warnings, ["--with-model needs a value"]);
  assert.deepEqual(shims.readStackArgs(["--yolo"]).warnings, ["roles inject does not take --yolo before --"]);
  const catalog = { revision: 1, defaultRoleId: "r1", workerDefaultRoleId: "r1", roles: [{ id: "r1", name: "Manager" }] };
  assert.match(shims.shimRoleNote("default", catalog).text, /catalog default when it runs \(today “Manager”\)/);
  assert.equal(shims.shimRoleNote("MANAGER", catalog).tone, "muted");
  assert.equal(shims.shimRoleNote("researcher", catalog).tone, "warning");
});

test("refusals are named without implying anything was written or removed", () => {
  assert.equal(shims.shimErrorText("stale Role shim revision: x").kind, "stale");
  const exists = shims.shimErrorText("refusing to replace an existing command: /home/me/.local/bin/claude2");
  assert.equal(exists.kind, "exists");
  assert.match(exists.text, /\/home\/me\/.local\/bin\/claude2.*never replaces/);
  const foreign = shims.shimErrorText("not a Stack-owned Role shim: /home/me/.local/bin/x");
  assert.equal(foreign.kind, "foreign");
  assert.match(foreign.text, /Nothing was changed/);
  assert.deepEqual(shims.shimErrorText("boom"), { kind: "other", text: "boom" });
});

test("an edit sees someone else's change or removal, but not its own save or a read from before it began", () => {
  const installed = shim("oc", complex, "1".repeat(64));
  const draft = shims.shimDraftFrom(installed, 100);
  const listing = (...list) => ({ binDir: "/home/me/.local/bin", shims: list });
  assert.deepEqual(shims.shimEditState(draft, listing(installed), 50), { listed: installed, gone: false, changed: null, dirty: false, invalid: null });
  // Editing the native side marks it dirty without touching the Stack side.
  const edited = { ...draft, vector: { ...draft.vector, native: [...draft.vector.native, "--print-logs"] } };
  assert.equal(shims.shimEditState(edited, listing(installed), 50).dirty, true);
  // Another writer replaced it: the edit is based on a revision a save would be refused for.
  const theirs = shim("oc", ["--", "codex"], "2".repeat(64));
  assert.equal(shims.shimEditState(edited, listing(theirs), 150).changed, theirs);
  // A listing older than the edit cannot say the shim is gone; a newer one can.
  assert.equal(shims.shimEditState(draft, listing(), 50).gone, false);
  assert.equal(shims.shimEditState(draft, listing(), 150).gone, true);
  // After this page saved over revision 1, a listing still showing revision 1 is stale, not a conflict.
  const saved = shims.shimDraftFrom(shim("oc", complex, "3".repeat(64)), 200, installed.revision);
  assert.equal(shims.shimEditState(saved, listing(installed), 250).changed, null);
  // A new shim is blocked until it has a free name and a harness.
  const fresh = shims.newShimDraft(0);
  assert.equal(shims.shimEditState(fresh, listing(installed), 0).dirty, false);
  assert.match(shims.shimEditState({ ...fresh, name: "oc" }, listing(installed), 0).invalid, /already/);
  assert.match(shims.shimEditState({ ...fresh, name: "oc2" }, listing(installed), 0).invalid, /Choose/);
  assert.equal(shims.shimEditState({ ...fresh, name: "oc2", vector: { ...fresh.vector, harness: "codex" } }, listing(installed), 0).invalid, null);
});

/** A fake server socket for the roles channel; records every call. */
function fakeServer(handlers) {
  const sockets = new Set();
  const calls = [];
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    readyState = FakeWebSocket.CONNECTING;
    subscriptions = new Map();
    constructor(url) {
      this.url = url;
      sockets.add(this);
      queueMicrotask(() => { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); });
    }
    send(raw) {
      const { id, method, params } = JSON.parse(raw);
      if (method === "events/subscribe") this.subscriptions.set(params.subscription, params);
      if (method === "events/unsubscribe") this.subscriptions.delete(params.subscription);
      let result, error;
      try {
        if (!method.startsWith("events/")) calls.push({ name: params.name, arguments: params.arguments });
        result = method.startsWith("events/") ? params : handlers[params.name]?.(params.arguments) ?? {};
      } catch (cause) {
        error = { message: cause instanceof Error ? cause.message : String(cause) };
      }
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id, ...(error ? { error } : { result }) }) }));
    }
    close() { this.readyState = 3; sockets.delete(this); this.onclose?.(); }
  }
  const publish = (pkg, topic) => {
    for (const socket of sockets) for (const subscription of socket.subscriptions.values()) {
      if (subscription.package === pkg && subscription.topics.includes(topic))
        socket.onmessage?.({ data: JSON.stringify({ method: "events/changed", params: { package: pkg, subscription: subscription.subscription, topic } }) });
    }
  };
  return { FakeWebSocket, sockets, calls, publish, topics: () => [...sockets].flatMap((socket) => [...socket.subscriptions.values()]).filter((item) => item.package === "roles").flatMap((item) => item.topics) };
}

const snapshot = (extra = {}) => {
  const resource = (data) => ({ data, error: null, at: 1 });
  return { server: resource(null), resources: resource(null), accounts: resource([]), workerAccounts: resource([]), workerRuntimes: resource([]),
    login: resource(null), workerLogins: resource([]), bots: resource([]), voice: resource(null), catalog: resource(null), roleCatalog: resource(null),
    endpoints: { roles: "ws://fixture.invalid/websocket" }, ...extra };
};

async function until(condition) {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(condition(), "condition was not reached");
}

const roleCatalog = () => ({ revision: 1, defaultRoleId: null, workerDefaultRoleId: null, roles: [] });

test("local shim writes send the exact vector and every outcome rereads the listing, as do notices and reconnects", async () => {
  const original = globalThis.WebSocket;
  let listing = [];
  const server = fakeServer({
    roles_snapshot: roleCatalog,
    role_shim_list: () => ({ binDir: "/home/me/.local/bin", shims: listing }),
    role_shim_create: ({ name, args }) => {
      if (name === "claude2") throw new Error("refusing to replace an existing command: /home/me/.local/bin/claude2");
      const created = shim(name, args, "1".repeat(64));
      listing = [created];
      return created;
    },
    role_shim_update: ({ expectedRevision }) => { throw new Error(expectedRevision === "0".repeat(64) ? "stale Role shim revision: oc" : "boom"); },
    role_shim_delete: ({ name }) => { throw new Error(`not a Stack-owned Role shim: /home/me/.local/bin/${name}`); },
  });
  globalThis.WebSocket = server.FakeWebSocket;
  const store = new StackStore(snapshot());
  const lists = () => server.calls.filter((call) => call.name === "role_shim_list").length;
  try {
    store.start({ packages: ["roles"], scopedBots: false });
    await until(() => store.getState().roleShims.data !== null && server.topics().includes("role_shims_changed"));
    assert.deepEqual(store.getState().roleShims.data, { binDir: "/home/me/.local/bin", shims: [] });

    let before = lists();
    const created = await store.call("roles", "role_shim_create", { name: "oc", args: complex });
    assert.deepEqual(server.calls.find((call) => call.name === "role_shim_create").arguments.args, complex, "the socket carries the vector unchanged");
    assert.deepEqual(created.args, complex);
    await until(() => store.getState().roleShims.data.shims.length === 1);
    assert.ok(lists() > before);

    for (const [name, args, pattern] of [
      ["role_shim_update", { name: "oc", expectedRevision: "0".repeat(64), args: complex }, /stale Role shim revision/],
      ["role_shim_create", { name: "claude2", args: complex }, /refusing to replace an existing command/],
      ["role_shim_delete", { name: "edited", expectedRevision: "1".repeat(64) }, /not a Stack-owned Role shim/],
    ]) {
      before = lists();
      await assert.rejects(store.call("roles", name, args), pattern);
      await until(() => lists() > before);
    }

    before = lists();
    server.publish("roles", "role_shims_changed");
    await until(() => lists() > before);

    before = lists();
    [...server.sockets][0].close();
    await until(() => lists() > before);
  } finally {
    store.stop();
    globalThis.WebSocket = original;
  }
});

test("a remote session never lists, subscribes to or writes Role shims", async () => {
  const original = globalThis.WebSocket;
  const server = fakeServer({ roles_snapshot: roleCatalog, role_shim_list: () => ({ binDir: "/x", shims: [] }) });
  globalThis.WebSocket = server.FakeWebSocket;
  const store = new StackStore(snapshot({ remote: { scope: "control", scopes: ["ui:view", "ui:control"], contentOrigins: { document: "", artifact: "" } } }));
  try {
    store.start({ packages: ["roles"], scopedBots: false });
    await until(() => server.calls.some((call) => call.name === "roles_snapshot") && server.topics().includes("role_changed"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(server.topics().includes("role_shims_changed"), false);
    assert.equal(server.calls.some((call) => call.name.startsWith("role_shim_")), false);
    assert.equal(store.getState().roleShims.data, null);
    for (const name of ["role_shim_list", "role_shim_create", "role_shim_update", "role_shim_delete"]) {
      await assert.rejects(store.call("roles", name, {}), /only on the local UI/);
    }
    assert.equal(server.calls.some((call) => call.name.startsWith("role_shim_")), false);
  } finally {
    store.stop();
    globalThis.WebSocket = original;
  }
});
