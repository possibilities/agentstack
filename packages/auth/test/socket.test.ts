import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { serveApi, socketCall, socketSubscribe } from "@agentstack/api";
import { AuthStore } from "../src/store.js";
import { accountRoot, prepareAccountProfile } from "../src/worker-accounts.js";

const fakeLogin = fileURLToPath(new URL("../../test/fixtures/fake-login.mjs", import.meta.url));

type ServedLogin = { id: string; status: string; authUrl: string | null; userCode: string | null; account: string | null; error: string | null; targetAccount: string | null };

function call(socket: string, name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  return socketCall(socket, "tools/call", { name, arguments: args });
}

test("auth serves accounts and device sign-in on its namespaced socket", { timeout: 60_000 }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-auth-api-"));
  const home = await mkdtemp(join(tmpdir(), "agentstack-auth-home-"));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  await mkdir(join(home, ".local", "libexec", "codexnk"), { recursive: true });
  await symlink(fakeLogin, join(home, ".local", "libexec", "codexnk", "codex"));
  const events: string[] = [];
  const served = await serveApi({
    name: "auth",
    transport: "socket",
    env: { ...process.env, AGENTSTACK_STATE_DIR: stateDir },
  });
  try {
    assert.equal(served.socketPath, join(stateDir, "sockets", "auth.sock"));
    const listed = (await socketCall(served.socketPath, "tools/list")) as {
      server: { name: string };
      transport: { type: string; path: string };
      websocket: unknown;
      events: { topics: Record<string, string>; subscribe: string } | null;
      tools: Array<{ name: string; description: string }>;
    };
    assert.equal(listed.server.name, "auth");
    assert.equal(listed.transport.type, "socket");
    assert.equal(listed.websocket, null);
    assert.deepEqual(listed.events, {
      topics: {
        accounts_changed: "Published when Bot account state or cross-inventory identity links change. Refresh account_list.",
        login_changed: "Published when a Codex device sign-in starts, shows its prompt, is superseded or cancelled, or finishes. Never carries the prompt or credentials.",
        worker_accounts_changed: "Published when Worker account state or cross-inventory identity links change. Refresh worker_account_list.",
      },
      subscribe: "events/subscribe",
    });
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      ["account_list", "account_set_enabled", "account_remove", "account_login_start", "account_login_replace", "account_login_status", "account_login_current", "account_login_cancel",
        "worker_account_list", "worker_account_prepare", "worker_account_confirm", "worker_account_set_enabled", "worker_account_remove"],
    );

    await assert.rejects(socketCall(served.socketPath, "events/subscribe", { topics: [] }), /non-empty/);
    await assert.rejects(socketCall(served.socketPath, "events/subscribe", { topics: ["bogus"] }), /unknown topic/);
    await assert.rejects(socketCall(served.socketPath, "events/subscribe", { topics: ["accounts_changed", "accounts_changed"] }), /duplicate topic/);
    await assert.rejects(socketCall(served.socketPath, "events/subscribe", {}), /non-empty/);

    const subscription = await socketSubscribe(served.socketPath ?? "", ["accounts_changed", "login_changed", "worker_accounts_changed"], (topic) => events.push(topic));
    assert.deepEqual([...subscription.topics].sort(), ["accounts_changed", "login_changed", "worker_accounts_changed"]);

    await assert.rejects(call(served.socketPath, "account_login_start", { name: "codex-1" }), /Unrecognized key: "name"/);
    await assert.rejects(call(served.socketPath, "account_login_replace", { id: "codex-1" }), /id:/);
    const started = (await call(served.socketPath, "account_login_start")) as ServedLogin;
    assert.equal(started.status, "pending");
    assert.equal(started.targetAccount, null);
    let current = (await call(served.socketPath, "account_login_current")) as { login: ServedLogin | null };
    for (let i = 0; i < 100 && !current.login?.authUrl; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      current = (await call(served.socketPath, "account_login_current")) as { login: ServedLogin | null };
    }
    assert.equal(current.login?.id, started.id);
    assert.equal(current.login?.authUrl, "https://auth.openai.com/codex/device");
    assert.equal(current.login?.userCode, "ABCD-EFGH");
    let settled = (await call(served.socketPath, "account_login_status", { id: started.id })) as ServedLogin;
    for (let i = 0; i < 100 && settled.status === "pending"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      settled = (await call(served.socketPath, "account_login_status", { id: started.id })) as ServedLogin;
    }
    assert.equal(settled.status, "complete");
    const firstId = settled.account!;
    assert.match(firstId, /^[0-9a-f-]{36}$/);
    assert.equal(settled.authUrl, null);
    assert.equal(settled.userCode, null);
    assert.deepEqual(await call(served.socketPath, "account_login_current"), { login: null });
    assert.deepEqual(await call(served.socketPath, "account_list"), { accounts: [{ id: firstId, enabled: true, removing: false, linkedAccounts: [] }] });
    assert.deepEqual(await call(served.socketPath, "worker_account_list"), { accounts: [] });

    const reauth = (await call(served.socketPath, "account_login_replace", { id: firstId })) as ServedLogin;
    assert.equal(reauth.targetAccount, firstId);
    let settledReauth = (await call(served.socketPath, "account_login_status", { id: reauth.id })) as ServedLogin;
    for (let i = 0; i < 100 && settledReauth.status === "pending"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      settledReauth = (await call(served.socketPath, "account_login_status", { id: reauth.id })) as ServedLogin;
    }
    assert.equal(settledReauth.status, "complete");
    assert.equal(settledReauth.account, firstId);
    const second = (await call(served.socketPath, "account_login_start")) as ServedLogin;
    let settledSecond = (await call(served.socketPath, "account_login_status", { id: second.id })) as ServedLogin;
    for (let i = 0; i < 100 && settledSecond.status === "pending"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      settledSecond = (await call(served.socketPath, "account_login_status", { id: second.id })) as ServedLogin;
    }
    const secondId = settledSecond.account!;
    assert.notEqual(secondId, firstId);
    assert.deepEqual(await call(served.socketPath, "account_set_enabled", { id: firstId, enabled: false }), { id: firstId, enabled: false, removing: false, linkedAccounts: [] });
    assert.deepEqual(await call(served.socketPath, "account_remove", { id: firstId }), { accounts: [{ id: secondId, enabled: true, removing: false, linkedAccounts: [] }] });
    await assert.rejects(call(served.socketPath, "account_set_enabled", { id: firstId, enabled: true }), /unknown/);
    await assert.rejects(socketCall(served.socketPath, "tools/call", { name: "server_list", arguments: {} }), /unknown operation/);

    for (let i = 0; i < 100 && !events.includes("accounts_changed"); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(events.includes("login_changed"));
    assert.ok(events.includes("accounts_changed"));
    assert.ok(events.includes("worker_accounts_changed"));

    const allResponses = JSON.stringify([
      settled, settledReauth, settledSecond,
      await call(served.socketPath, "account_list"),
      await call(served.socketPath, "account_login_status", { id: started.id }),
    ]);
    assert.ok(!allResponses.includes("fixture-secret"));
    assert.ok(!allResponses.includes("refresh_token"));

    await subscription.close();
    await served.close();
    await assert.rejects(socketCall(served.socketPath, "tools/list"), /ECONNREFUSED|ENOENT|closed/);
  } finally {
    await served.close();
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    await rm(stateDir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("Bot and Worker auth operations do not couple even for a legacy shared ID", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-auth-independent-"));
  const store = new AuthStore(stateDir);
  const credentials = JSON.stringify({ tokens: { access_token: "access", refresh_token: "refresh", id_token: "fixture.jwt.signature" } });
  const nativeIdentity = "unrelated-native-identity";
  const access = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: nativeIdentity } })).toString("base64url")}.signature`;
  const first = store.addAccount(credentials);
  const second = store.addAccount(credentials);
  const matchingBot = store.addAccount(JSON.stringify({ tokens: { access_token: access, refresh_token: "refresh", id_token: "fixture.jwt.signature" } }));
  const config = new DatabaseSync(join(stateDir, "configuration.sqlite"));
  for (const id of [first.id, second.id]) {
    config.prepare("INSERT INTO worker_accounts (id, provider) VALUES (?, 'codex')").run(id);
    await prepareAccountProfile(stateDir, { id, provider: "codex", enabled: true, ready: false, removing: false });
  }
  config.close();
  store.close();
  const served = await serveApi({ name: "auth", transport: "socket", env: { ...process.env, AGENTSTACK_STATE_DIR: stateDir } });
  const request = (name: string, args: Record<string, unknown> = {}) => call(served.socketPath ?? "", name, args);
  try {
    assert.equal(((await request("worker_account_list")) as { accounts: unknown[] }).accounts.length, 2);
    await request("account_set_enabled", { id: first.id, enabled: false });
    assert.deepEqual(await request("worker_account_set_enabled", { id: first.id, enabled: false }),
      { id: first.id, provider: "codex", enabled: false, ready: false, removing: false, linkedAccounts: [] });
    await request("worker_account_set_enabled", { id: first.id, enabled: true });
    await request("account_remove", { id: first.id });
    assert.equal((await stat(accountRoot(stateDir, first.id))).isDirectory(), true);
    assert.ok(((await request("worker_account_list")) as { accounts: Array<{ id: string }> }).accounts.some((account) => account.id === first.id));
    await request("worker_account_remove", { id: second.id });
    assert.ok(((await request("account_list")) as { accounts: Array<{ id: string }> }).accounts.some((account) => account.id === second.id));
    await request("account_set_enabled", { id: second.id, enabled: false });
    const prepared = await request("worker_account_prepare", { provider: "codex" }) as { account: { id: string; ready: boolean } };
    assert.notEqual(prepared.account.id, second.id);
    assert.equal(prepared.account.ready, false);
    await assert.rejects(request("worker_account_prepare", { provider: "codex", id: second.id }), /worker account is unavailable/);
    await mkdir(join(accountRoot(stateDir, prepared.account.id), "data/opencode"), { recursive: true });
    const path = join(accountRoot(stateDir, prepared.account.id), "data/opencode/opencode.db");
    const native = new DatabaseSync(path);
    native.exec("CREATE TABLE credential (integration_id TEXT, value TEXT)");
    native.prepare("INSERT INTO credential VALUES (?, ?)").run("openai", JSON.stringify({ type: "oauth", access, refresh: "worker-refresh" }));
    native.close();
    await chmod(path, 0o600);
    const confirmed = await request("worker_account_confirm", { id: prepared.account.id }) as { ready: boolean };
    assert.equal(confirmed.ready, true);
    assert.ok(((await request("account_list")) as { accounts: Array<{ id: string }> }).accounts.every((account) => account.id !== prepared.account.id));
    const bots = (await request("account_list")) as { accounts: Array<{ id: string; linkedAccounts: Array<{ scope: string; id: string }> }> };
    const workers = (await request("worker_account_list")) as { accounts: Array<{ id: string; linkedAccounts: Array<{ scope: string; id: string }> }> };
    assert.deepEqual(bots.accounts.find((account) => account.id === matchingBot.id)?.linkedAccounts,
      [{ scope: "worker", id: prepared.account.id }]);
    assert.deepEqual(workers.accounts.find((account) => account.id === prepared.account.id)?.linkedAccounts,
      [{ scope: "bot", id: matchingBot.id }]);
    assert.equal(JSON.stringify({ bots, workers }).includes(nativeIdentity), false);
    assert.equal(JSON.stringify({ bots, workers }).includes(access), false);
    assert.equal(JSON.stringify({ bots, workers }).includes("worker-refresh"), false);
    await request("account_remove", { id: matchingBot.id });
    assert.deepEqual(((await request("worker_account_list")) as typeof workers).accounts.find((account) => account.id === prepared.account.id)?.linkedAccounts, []);
    await request("worker_account_remove", { id: first.id });
  } finally { await served.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test("auth subscription ends when the connection drops and shutdown does not hang", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-auth-sub-"));
  const served = await serveApi({
    name: "auth",
    transport: "socket",
    env: { ...process.env, AGENTSTACK_STATE_DIR: stateDir },
  });
  try {
    const received: string[] = [];
    const subscription = await socketSubscribe(served.socketPath ?? "", ["accounts_changed"], (topic) => received.push(topic));
    served.publish?.("accounts_changed");
    for (let i = 0; i < 100 && received.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(received, ["accounts_changed"]);
    assert.throws(() => served.publish?.("bogus"), /unknown topic/);
    const closed = subscription.closed;
    await served.close();
    await closed;
  } finally {
    await served.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
