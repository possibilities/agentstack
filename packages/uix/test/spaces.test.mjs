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
  assert.deepEqual(homeOf({ kind: "worker", id: "w-1" }), { kind: "space", space: "workers", window: "workers" });
  assert.deepEqual(homeOf({ kind: "worker-window", id: "worker-2" }), { kind: "space", space: "workers", window: "worker-2" });
  assert.deepEqual(homeOf({ kind: "worker-runtime", id: "acc-1" }), { kind: "space", space: "workers", window: "worker-runtimes" });
  assert.deepEqual(homeOf({ kind: "category", id: "c1" }), { kind: "space", space: "roles", window: "role-instructions" });
  assert.deepEqual(homeOf({ kind: "fragment", id: "f1" }), { kind: "space", space: "roles", window: "role-instructions" });
  assert.deepEqual(homeOf({ kind: "notification", id: "n1" }), { kind: "space", space: "inbox", window: "notify-inbox" });
  assert.deepEqual(homeOf({ kind: "skill", id: "s1" }), { kind: "space", space: "roles", window: "role-skills" });
  assert.deepEqual(homeOf({ kind: "mcp-server", id: "m1" }), { kind: "space", space: "roles", window: "role-mcp-servers" });
  assert.deepEqual(homeOf({ kind: "trusted-project", id: "p1" }), { kind: "space", space: "roles", window: "role-projects" });
  assert.deepEqual(homeOf({ kind: "document", id: "first-note" }), { kind: "space", space: "content", window: "content-documents" });
  assert.deepEqual(homeOf({ kind: "collection", id: "notes" }), { kind: "space", space: "content", window: "content-library" });
  assert.deepEqual(homeOf({ kind: "item", id: "0fd9d71a-8b46-4c79-9e1a-3a05f1f2f5d2" }), { kind: "space", space: "content", window: "content-library" });
  assert.deepEqual(homeOf({ kind: "artifact", id: "test-bundle" }), { kind: "space", space: "content", window: "content-artifacts" });
  assert.deepEqual(homeOf({ kind: "package", id: "bots" }), { kind: "reference" });
  assert.deepEqual(homeOf({ kind: "operation", id: "bot_start", pkg: "bots" }), { kind: "reference" });
  assert.deepEqual(homeOf({ kind: "usage" }), { kind: "space", space: "accounts", window: "usage" });
  assert.deepEqual(homeOf({ kind: "usage-account", id: "bot:a1" }), { kind: "space", space: "accounts", window: "usage" });
  assert.deepEqual(homeOf({ kind: "grok-bot-usage" }), { kind: "space", space: "accounts", window: "usage" });
  assert.deepEqual(homeOf({ kind: "worker-catalog", id: "w1" }), { kind: "space", space: "accounts", window: "model-catalogs" });
  assert.deepEqual(homeOf({ kind: "signal" }), { kind: "space", space: "signal", window: "signal" });
  assert.deepEqual(homeOf({ kind: "attention-item", id: "r:0" }), { kind: "space", space: "signal", window: "attention" });
  assert.deepEqual(homeOf({ kind: "attention-message", id: "m" }), { kind: "space", space: "signal", window: "attention-messages" });
  assert.deepEqual(homeOf({ kind: "attention-run", id: "r" }), { kind: "space", space: "signal", window: "attention-runs" });
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
  assert.equal(parseSpacePath("/x/roles"), "roles");
  assert.equal(parseSpacePath("/x/inbox"), "inbox");
  assert.equal(parseSpacePath("/x/signal"), "signal");
  assert.equal(parseSpacePath("/x/content"), "content");
  assert.equal(parseSpacePath("/x/workers"), "workers");
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
    { kind: "category", id: "00000000-0000-4000-8000-000000000001" },
    { kind: "fragment", id: "00000000-0000-4000-8000-000000000002" },
    { kind: "notification", id: "00000000-0000-4000-8000-000000000003" },
    { kind: "skill", id: "00000000-0000-4000-8000-000000000006" },
    { kind: "mcp-server", id: "00000000-0000-4000-8000-000000000007" },
    { kind: "trusted-project", id: "00000000-0000-4000-8000-000000000008" },
    { kind: "usage" },
    { kind: "usage-account", id: "worker:account-with-colons:ok" },
    { kind: "grok-bot-usage" },
    { kind: "worker-catalog", id: "w1" },
    { kind: "worker", id: "0fd9d71a-8b46-4c79-9e1a-3a05f1f2f5d2" },
    { kind: "worker-runtime", id: "w1" },
    { kind: "worker-window", id: "worker-2" },
    { kind: "signal" },
    { kind: "attention-item", id: "3f0c1b7e-run:2" },
    { kind: "attention-message", id: "a".repeat(64) },
    { kind: "attention-run", id: "3f0c1b7e-run" },
    { kind: "package", id: "bots" },
    { kind: "operation", id: "bot_start", pkg: "bots" },
    { kind: "document", id: "first-note" },
    { kind: "collection", id: "notes" },
    { kind: "item", id: "0fd9d71a-8b46-4c79-9e1a-3a05f1f2f5d2" },
    { kind: "artifact", id: "test-bundle" },
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
  notifyCounts: { data: null, error: null, at: null },
  signalStatus: { data: null, error: null, at: null },
};

test("spaceAttention reports human reasons per space and ignores healthy state", () => {
  assert.deepEqual(spaceAttention(quiet), { fleet: [], accounts: [], lab: [], roles: [], system: [], inbox: [], signal: [], content: [], workers: [], api: [] });
  assert.deepEqual(spaceAttention({ ...quiet, notifyCounts: { data: { open: 0, total: 4, sources: [] }, error: null, at: null } }).inbox, []);
  assert.deepEqual(spaceAttention({ ...quiet, notifyCounts: { data: { open: 1, total: 4, sources: [] }, error: null, at: null } }).inbox, ["1 open notification"]);
  const inbox = spaceAttention({ ...quiet, notifyCounts: { data: { open: 3, total: 4, sources: [] }, error: null, at: null }, status: { notify: "closed" } });
  assert.deepEqual(inbox.inbox, ["3 open notifications", "notify reconnecting"]);
  assert.deepEqual(inbox.system, ["notify reconnecting"]);

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
  assert.deepEqual(workers.workers, []);

  // Workers: permission waits, recovery, failures and runtime errors; idle, running and closed Workers are quiet.
  const session = (id, phase, issue = null) => ({ id, botId: "bot-1", threadId: "t", accountId: "w1", provider: "claude", model: "opus", effort: "high",
    repo: "/src/agentstack", cwd: null, branch: null, baseCommit: null, sourceDirty: false, roleRevision: 1, sessionId: null, runtimeInstance: null,
    phase, currentTurnId: null, issue, createdAt: 1, updatedAt: 1 });
  const sessions = spaceAttention({
    ...quiet,
    workerSessions: { data: [session("aaaaaaaa-1", "awaiting_input"), session("bbbbbbbb-2", "needs_recovery", "Owner restarted"), session("cccccccc-3", "failed"),
      session("dddddddd-4", "idle"), session("eeeeeeee-5", "running"), session("ffffffff-6", "closed")], error: null, at: null },
    workerRuntimes: { data: [{ id: "w1", provider: "claude", backend: "claude-sdk", processModel: "session", pids: [], state: "error", pid: null, instance: null, error: "sdk missing" }], error: null, at: null },
    status: { worker: "closed" },
  });
  assert.deepEqual(sessions.workers, ["agentstack · aaaaaa: Waiting for its Bot to answer a permission request", "agentstack · bbbbbb: Owner restarted",
    "agentstack · cccccc: Failed", "claude runtime error: sdk missing", "worker reconnecting"]);

  // System: a stopped child, a closed owner channel, a status read error, resource errors and stale attribution.
  const system = spaceAttention({
    ...quiet,
    owner: { data: { pid: 1, indexUrl: null, uixUrl: null, inspectorUrl: null, mcpUrls: {}, children: [{ name: "content", pid: null, running: false, exitCode: 1, signal: null, error: "crashed" }, { name: "api", pid: 2, running: true, exitCode: null, signal: null, error: null }] }, error: "socket read failed", at: null },
    resources: { data: { observation: { error: "collection_timeout", coverage: { domains: [{ source: "bots", state: "stale", unmatched: 0, capturedAt: null, error: null }, { source: "worker", state: "current", unmatched: 2, capturedAt: null, error: null }] } } }, error: "sampler read failed", at: null },
    status: { owner: "closed" },
  });
  assert.deepEqual(system.system, ["content stopped", "owner reconnecting", "Owner status: socket read failed", "Resources: sampler read failed", "Resource sampling: collection_timeout", "bots attribution stale"]);
  assert.deepEqual(system.fleet, []);
  assert.deepEqual(system.accounts, []);

  // API: a discovery error and a closed api channel; the closed channel also flags System.
  const api = spaceAttention({ ...quiet, catalog: { data: null, error: "api.sock refused", at: null }, status: { api: "closed" } });
  assert.deepEqual(api.api, ["Discovery: api.sock refused", "api reconnecting"]);
  assert.deepEqual(api.system, ["api reconnecting"]);

  // Roles: only a closed channel needs attention.
  assert.deepEqual(spaceAttention({ ...quiet, status: { roles: "closed" } }).roles, ["roles reconnecting"]);

  // Content: a closed channel and uploads that stalled or failed; finished and running uploads are quiet.
  const content = spaceAttention({ ...quiet, status: { content: "closed" }, contentUploads: [
    { key: "u1", name: "a.png", phase: "stalled" }, { key: "u2", name: "b.pdf", phase: "failed" },
    { key: "u3", name: "c.md", phase: "done" }, { key: "u4", name: "d.md", phase: "uploading" },
  ] });
  assert.deepEqual(content.content, ["content reconnecting", "a.png upload stalled", "b.pdf upload failed"]);
  assert.deepEqual(content.system, ["content reconnecting"]);

  // Idle and connecting channels are normal, not attention.
  const waiting = spaceAttention({ ...quiet, status: { auth: "connecting", bots: "idle", owner: "connecting", api: "idle" } });
  assert.deepEqual(waiting, { fleet: [], accounts: [], lab: [], roles: [], system: [], inbox: [], signal: [], content: [], workers: [], api: [] });
});

test("spaceAttention flags Signal's unreadable sources, failed interpretation and channel, but not a deliberate pause", () => {
  const status = (patch) => ({ enabled: false, activatedAt: null, baselined: false, settings: { model: "m", reasoningEffort: "low", accountId: null, revision: 1 },
    lastScan: null, lastInference: null, sourceErrors: [], jobs: [{ state: "pending", count: 4 }], messages: 0, runs: 0, changeSeq: 0, ...patch });
  assert.deepEqual(spaceAttention({ ...quiet, signalStatus: { data: status({}), error: null, at: 1 } }).signal, []);
  const noisy = spaceAttention({ ...quiet, status: { signal: "closed" },
    signalStatus: { data: status({ sourceErrors: [{ source: "bot:bot-1", error: "socket refused" }], lastInference: { at: 1, error: "no_available_codex_account" } }), error: null, at: 1 } });
  assert.deepEqual(noisy.signal, ["signal reconnecting", "bot:bot-1 unreadable", "Last interpretation failed: no_available_codex_account"]);
  assert.ok(noisy.system.includes("signal reconnecting"));
});
