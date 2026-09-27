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

test("homeOf distinguishes spatial records from reference destinations", () => {
  assert.deepEqual(homeOf({ kind: "owner" }), { kind: "space", space: "system", window: "owner" });
  assert.deepEqual(homeOf({ kind: "child", id: "uix" }), { kind: "space", space: "system", window: "owner" });
  assert.deepEqual(homeOf({ kind: "resource", id: "total" }), { kind: "space", space: "system", window: "resources" });
  assert.deepEqual(homeOf({ kind: "resource", id: "component:bots" }), { kind: "space", space: "system", window: "resources" });
  assert.deepEqual(homeOf({ kind: "process", id: "process:123:abc" }), { kind: "space", space: "system", window: "processes" });
  assert.deepEqual(homeOf({ kind: "account", id: "acc-1" }), { kind: "space", space: "accounts", window: "accounts" });
  assert.deepEqual(homeOf({ kind: "worker-account", id: "w-1" }), { kind: "space", space: "accounts", window: "accounts" });
  assert.deepEqual(homeOf({ kind: "login" }), { kind: "space", space: "accounts", window: "accounts" });
  assert.deepEqual(homeOf({ kind: "bot", id: "bot-1" }), { kind: "space", space: "fleet", window: "bots" });
  assert.deepEqual(homeOf({ kind: "package", id: "bots" }), { kind: "reference" });
  assert.deepEqual(homeOf({ kind: "operation", id: "bot_start", pkg: "bots" }), { kind: "reference" });
  assert.deepEqual(homeOf({ kind: "usage" }), { kind: "space", space: "accounts", window: "usage" });
  assert.deepEqual(homeOf({ kind: "usage-account", id: "bot:a1" }), { kind: "space", space: "accounts", window: "usage" });
  assert.deepEqual(homeOf({ kind: "grok-bot-usage" }), { kind: "space", space: "accounts", window: "usage" });
  assert.deepEqual(homeOf({ kind: "worker-catalog", id: "w1" }), { kind: "space", space: "accounts", window: "model-catalogs" });
});

test("spaceHref builds space links with an optional encoded focus", () => {
  assert.equal(spaceHref("fleet"), "/x/fleet");
  assert.equal(spaceHref("fleet", { kind: "bot", id: "bot-1" }), "/x/fleet?focus=bot%3Abot-1");
  assert.equal(spaceHref("accounts", { kind: "account", id: "a1" }), "/x/accounts?focus=account%3Aa1");
});

test("parseSpacePath resolves /x and single space segments only", () => {
  assert.equal(parseSpacePath("/x"), "fleet");
  assert.equal(parseSpacePath("/x/"), "fleet");
  assert.equal(parseSpacePath("/x/api"), null);
  assert.equal(parseSpacePath("/x/api/"), null);
  assert.equal(parseSpacePath("/x/system"), "system");
  assert.equal(parseSpacePath("/x/system/"), "system");
  assert.equal(parseSpacePath("/x/fleet"), "fleet");
  assert.equal(parseSpacePath("/x/accounts"), "accounts");
  assert.equal(parseSpacePath("/x/lab"), "lab");
  assert.equal(parseSpacePath("/x/nope"), null);
  assert.equal(parseSpacePath("/x/api/extra"), null);
  assert.equal(parseSpacePath("/y"), null);
  assert.equal(parseSpacePath("/"), null);
});

test("parseNodeKey inverts nodeKey for every kind and rejects malformed keys", () => {
  const refs = [
    { kind: "owner" },
    { kind: "child", id: "uix" },
    { kind: "resource", id: "component:uix" },
    { kind: "process", id: "process:482:some-birth-id" },
    { kind: "account", id: "acc-1" },
    { kind: "worker-account", id: "0fd9d71a-8b46-4c79-9e1a-3a05f1f2f5d2" },
    { kind: "login" },
    { kind: "bot", id: "bot-1" },
    { kind: "usage" },
    { kind: "usage-account", id: "worker:account-with-colons:ok" },
    { kind: "grok-bot-usage" },
    { kind: "worker-catalog", id: "w1" },
    { kind: "package", id: "bots" },
    { kind: "operation", id: "bot_start", pkg: "bots" },
  ];
  for (const ref of refs) assert.deepEqual(parseNodeKey(nodeKey(ref)), ref);
  for (const bad of ["", "bogus", "account:", "operation:bots"]) assert.equal(parseNodeKey(bad), null);
});

const quiet = {
  status: {},
  owner: { data: null, error: null, at: null },
  resources: { data: null, error: null, at: null },
  accounts: { data: [], error: null, at: null },
  workerAccounts: { data: [], error: null, at: null },
  bots: { data: [], error: null, at: null },
  attempt: null,
  catalog: { data: [], error: null, at: null },
  endpoints: {},
};

test("spaceAttention reports human reasons per space and ignores healthy state", () => {
  assert.deepEqual(spaceAttention(quiet), { fleet: [], accounts: [], lab: [], system: [], api: [] });

  // Fleet: a bot recovery issue and its channel. Accounts: an unfinished removal, a failed sign-in, its channels.
  const fleet = spaceAttention({
    ...quiet,
    bots: { data: [{ id: "bot-1", pid: null, cwd: "/tmp", url: null, state: "stopped", account: null, runningAccount: null, mainThreadId: null, recoveryIssue: "orphaned app-server", roleRevision: null, settings: null }], error: null, at: null },
    accounts: { data: [{ id: "a1", enabled: true, removing: false, linkedAccounts: [] }, { id: "a2", enabled: false, removing: true, linkedAccounts: [] }], error: null, at: null },
    attempt: { id: "l1", status: "failed", authUrl: null, userCode: null, account: null, error: "denied", targetAccount: null },
    status: { auth: "closed", bots: "closed", usage: "closed" },
  });
  assert.deepEqual(fleet.fleet, ["bot-1 needs inspection", "bots reconnecting"]);
  assert.deepEqual(fleet.accounts, ["codex-bot-account-2 removal unfinished", "Sign-in failed", "auth reconnecting", "usage reconnecting"]);
  // The System space carries every closed channel, like the old dock button did.
  assert.deepEqual(fleet.system, ["auth reconnecting", "bots reconnecting", "usage reconnecting"]);

  // Worker accounts flag unfinished removals and unconfirmed sign-ins, labelled per provider.
  const workers = spaceAttention({
    ...quiet,
    workerAccounts: { data: [
      { id: "w1", provider: "codex", enabled: true, ready: true, removing: true, linkedAccounts: [] },
      { id: "w2", provider: "codex", enabled: true, ready: false, removing: false, linkedAccounts: [] },
      { id: "w3", provider: "grok", enabled: true, ready: false, removing: false, linkedAccounts: [] },
      { id: "w4", provider: "grok", enabled: true, ready: true, removing: false, linkedAccounts: [] },
    ], error: null, at: null },
  });
  assert.deepEqual(workers.fleet, []);
  assert.deepEqual(workers.accounts, ["codex-worker-account-1 removal unfinished", "codex-worker-account-2 needs sign-in", "grok-worker-account-1 needs sign-in"]);

  // System: a stopped child, a closed owner channel, a status read error, resource errors and stale attribution.
  const system = spaceAttention({
    ...quiet,
    owner: { data: { pid: 1, indexUrl: null, uixUrl: null, inspectorUrl: null, mcpUrls: {}, children: [{ name: "content", pid: null, running: false, exitCode: 1, signal: null, error: "crashed" }, { name: "api", pid: 2, running: true, exitCode: null, signal: null, error: null }] }, error: "socket read failed", at: null },
    resources: { data: { observation: { error: "collection_timeout", coverage: { domains: [{ source: "bots", state: "stale", unmatched: 0, capturedAt: null, error: null }, { source: "workers", state: "current", unmatched: 2, capturedAt: null, error: null }] } } }, error: "sampler read failed", at: null },
    status: { owner: "closed" },
  });
  assert.deepEqual(system.system, ["content stopped", "owner reconnecting", "Owner status: socket read failed", "Resources: sampler read failed", "Resource sampling: collection_timeout", "bots attribution stale"]);
  assert.deepEqual(system.fleet, []);
  assert.deepEqual(system.accounts, []);

  // API: a discovery error and a closed api channel; the closed channel also flags System.
  const api = spaceAttention({ ...quiet, catalog: { data: null, error: "api.sock refused", at: null }, status: { api: "closed" } });
  assert.deepEqual(api.api, ["Discovery: api.sock refused", "api reconnecting"]);
  assert.deepEqual(api.system, ["api reconnecting"]);

  // Idle and connecting channels are normal, not attention.
  const waiting = spaceAttention({ ...quiet, status: { auth: "connecting", bots: "idle", owner: "connecting", api: "idle" } });
  assert.deepEqual(waiting, { fleet: [], accounts: [], lab: [], system: [], api: [] });
});
