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

const { homeOf, spaceHref, parseSpacePath, parseNodeKey, spaceAttention } = await import("../lib/stack/spaces.ts");
const { nodeKey } = await import("../lib/stack/types.ts");

test("homeOf maps every node kind to its space and window", () => {
  assert.deepEqual(homeOf({ kind: "owner" }), { space: "system", window: "system" });
  assert.deepEqual(homeOf({ kind: "child", id: "uix" }), { space: "system", window: "system" });
  assert.deepEqual(homeOf({ kind: "account", id: "acc-1" }), { space: "fleet", window: "accounts" });
  assert.deepEqual(homeOf({ kind: "login" }), { space: "fleet", window: "accounts" });
  assert.deepEqual(homeOf({ kind: "bot", id: "bot-1" }), { space: "fleet", window: "bots" });
  assert.deepEqual(homeOf({ kind: "package", id: "bots" }), { space: "api", window: "package:bots" });
  assert.deepEqual(homeOf({ kind: "operation", id: "bot_start", pkg: "bots" }), { space: "api", window: "package:bots" });
});

test("spaceHref builds space links with an optional encoded focus", () => {
  assert.equal(spaceHref("system"), "/x/system");
  assert.equal(spaceHref("api", { kind: "operation", id: "bot_start", pkg: "bots" }), "/x/api?focus=operation%3Abots.bot_start");
  assert.equal(spaceHref("fleet", { kind: "bot", id: "bot-1" }), "/x/fleet?focus=bot%3Abot-1");
});

test("parseSpacePath resolves /x and single space segments only", () => {
  assert.equal(parseSpacePath("/x"), "fleet");
  assert.equal(parseSpacePath("/x/"), "fleet");
  assert.equal(parseSpacePath("/x/api"), "api");
  assert.equal(parseSpacePath("/x/api/"), "api");
  assert.equal(parseSpacePath("/x/system"), "system");
  assert.equal(parseSpacePath("/x/fleet"), "fleet");
  assert.equal(parseSpacePath("/x/nope"), null);
  assert.equal(parseSpacePath("/x/api/extra"), null);
  assert.equal(parseSpacePath("/y"), null);
  assert.equal(parseSpacePath("/"), null);
});

test("parseNodeKey inverts nodeKey for every kind and rejects malformed keys", () => {
  const refs = [
    { kind: "owner" },
    { kind: "child", id: "uix" },
    { kind: "account", id: "acc-1" },
    { kind: "login" },
    { kind: "bot", id: "bot-1" },
    { kind: "package", id: "bots" },
    { kind: "operation", id: "bot_start", pkg: "bots" },
  ];
  for (const ref of refs) assert.deepEqual(parseNodeKey(nodeKey(ref)), ref);
  for (const bad of ["", "bogus", "account:", "operation:bots"]) assert.equal(parseNodeKey(bad), null);
});

const quiet = {
  status: {},
  owner: { data: null, error: null, at: null },
  accounts: { data: [], error: null, at: null },
  bots: { data: [], error: null, at: null },
  attempt: null,
  catalog: { data: [], error: null, at: null },
  endpoints: {},
};

test("spaceAttention reports human reasons per space and ignores healthy state", () => {
  assert.deepEqual(spaceAttention(quiet), { fleet: [], system: [], api: [] });

  // Fleet: a bot recovery issue, an unfinished removal, a failed sign-in, closed channels.
  const fleet = spaceAttention({
    ...quiet,
    bots: { data: [{ id: "bot-1", pid: null, cwd: "/tmp", url: null, state: "stopped", account: null, runningAccount: null, mainThreadId: null, recoveryIssue: "orphaned app-server", roleRevision: null, settings: null }], error: null, at: null },
    accounts: { data: [{ id: "a1", enabled: true, removing: false, linkedAccounts: [] }, { id: "a2", enabled: false, removing: true, linkedAccounts: [] }], error: null, at: null },
    attempt: { id: "l1", status: "failed", authUrl: null, userCode: null, account: null, error: "denied", targetAccount: null },
    status: { auth: "closed", bots: "closed" },
  });
  assert.deepEqual(fleet.fleet, ["bot-1 needs inspection", "codex-2 removal unfinished", "Sign-in failed", "auth reconnecting", "bots reconnecting"]);
  assert.deepEqual(fleet.system, []);

  // System: a stopped child, a closed owner channel, a status read error.
  const system = spaceAttention({
    ...quiet,
    owner: { data: { pid: 1, docsUrl: null, indexUrl: null, uixUrl: null, inspectorUrl: null, mcpUrls: {}, children: [{ name: "wiki", pid: null, running: false, exitCode: 1, signal: null, error: "crashed" }, { name: "api", pid: 2, running: true, exitCode: null, signal: null, error: null }] }, error: "socket read failed", at: null },
    status: { owner: "closed" },
  });
  assert.deepEqual(system.system, ["wiki stopped", "owner reconnecting", "Owner status: socket read failed"]);
  assert.deepEqual(system.fleet, []);

  // API: a discovery error and a closed api channel.
  const api = spaceAttention({ ...quiet, catalog: { data: null, error: "api.sock refused", at: null }, status: { api: "closed" } });
  assert.deepEqual(api.api, ["Discovery: api.sock refused", "api reconnecting"]);

  // Idle and connecting channels are normal, not attention.
  const waiting = spaceAttention({ ...quiet, status: { auth: "connecting", bots: "idle", owner: "connecting", api: "idle" } });
  assert.deepEqual(waiting, { fleet: [], system: [], api: [] });
});
