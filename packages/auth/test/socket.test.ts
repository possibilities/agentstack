import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { createServer } from "node:net";
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
        accounts_changed: "Published when Bot account state or its paired Worker link changes. Refresh account_list.",
        login_changed: "Published when a Codex device sign-in starts, shows its prompt, is superseded or cancelled, or finishes. Never carries the prompt or credentials.",
        worker_accounts_changed: "Published when Worker account state or its paired Bot link changes. Refresh worker_account_list.",
        worker_login_changed: "Published when a Worker sign-in starts, shows its link or code, needs a pasted code, is superseded or cancelled, or finishes. Never carries the prompt or credentials.",
      },
      subscribe: "events/subscribe",
    });
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      ["account_list", "account_set_enabled", "account_remove", "account_login_start", "account_login_replace", "account_login_status", "account_login_current", "account_login_cancel",
        "worker_account_list", "worker_account_prepare", "worker_account_confirm", "worker_account_set_enabled", "worker_account_remove",
        "worker_account_login_start", "worker_account_login_status", "worker_account_login_current", "worker_account_login_submit", "worker_account_login_cancel"],
    );

    await assert.rejects(socketCall(served.socketPath, "events/subscribe", { topics: [] }), /non-empty/);
    await assert.rejects(socketCall(served.socketPath, "events/subscribe", { topics: ["bogus"] }), /unknown topic/);
    await assert.rejects(socketCall(served.socketPath, "events/subscribe", { topics: ["accounts_changed", "accounts_changed"] }), /duplicate topic/);
    await assert.rejects(socketCall(served.socketPath, "events/subscribe", {}), /non-empty/);

    const subscription = await socketSubscribe(served.socketPath ?? "", ["accounts_changed", "login_changed", "worker_accounts_changed", "worker_login_changed"], (topic) => events.push(topic));
    assert.deepEqual([...subscription.topics].sort(), ["accounts_changed", "login_changed", "worker_accounts_changed", "worker_login_changed"]);

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
    const firstPair = ((await call(served.socketPath, "account_list")) as { accounts: Array<{ linkedAccounts: Array<{ scope: string; id: string }> }> }).accounts[0]!.linkedAccounts;
    assert.equal(firstPair.length, 1);
    assert.deepEqual(await call(served.socketPath, "account_list"), { accounts: [{ id: firstId, enabled: true, removing: false, linkedAccounts: firstPair }] });
    // The new Bot account's paired Codex Worker exists and awaits its own sign-in.
    assert.deepEqual(await call(served.socketPath, "worker_account_list"), { accounts: [{ id: firstPair[0]!.id, provider: "codex",
      enabled: true, ready: false, removing: false, linkedAccounts: [{ scope: "bot", id: firstId }] }] });

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
    assert.deepEqual(await call(served.socketPath, "account_set_enabled", { id: firstId, enabled: false }), { id: firstId, enabled: false, removing: false, linkedAccounts: firstPair });
    assert.deepEqual(await call(served.socketPath, "account_remove", { id: firstId }), { accounts: [{ id: secondId, enabled: true, removing: false,
      linkedAccounts: ((await call(served.socketPath, "worker_account_list")) as { accounts: Array<{ id: string; linkedAccounts: Array<{ id: string }> }> }).accounts
        .filter((account) => account.linkedAccounts.some((link) => link.id === secondId)).map((account) => ({ scope: "worker", id: account.id })) }] });
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

const botLogin = (identity?: string) => JSON.stringify({ tokens: { refresh_token: "refresh", id_token: "fixture.jwt.signature",
  access_token: identity ? `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: identity } })).toString("base64url")}.signature` : "access" } });

async function nativeCodexLogin(stateDir: string, id: string, identity: string): Promise<void> {
  await prepareAccountProfile(stateDir, { id, provider: "codex", enabled: true, ready: false, removing: false });
  await mkdir(join(accountRoot(stateDir, id), "data/opencode"), { recursive: true });
  const path = join(accountRoot(stateDir, id), "data/opencode/opencode.db");
  await rm(path, { force: true });
  const native = new DatabaseSync(path);
  native.exec("CREATE TABLE credential (integration_id TEXT, value TEXT)");
  native.prepare("INSERT INTO credential VALUES (?, ?)").run("openai", JSON.stringify({ type: "oauth", access: `worker-access-${identity}`, refresh: "worker-refresh", metadata: { accountID: identity } }));
  native.close();
  await chmod(path, 0o600);
}

test("each Codex Bot account has one paired Codex Worker, created and removed with it", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-auth-paired-"));
  const store = new AuthStore(stateDir);
  const matching = store.addAccount(botLogin("native-a"));
  const unmatched = store.addAccount(botLogin("native-b"));
  const removed = store.addAccount(botLogin());
  const olderWorker = "00000000-0000-4000-8000-00000000000a", strayWorker = "00000000-0000-4000-8000-00000000000b";
  // Accounts from before pairing: no Worker rows are paired yet.
  const config = new DatabaseSync(join(stateDir, "configuration.sqlite"));
  config.exec("DELETE FROM worker_accounts");
  for (const [id, identity] of [[olderWorker, "native-a"], [strayWorker, "someone-else"]] as const) {
    config.prepare("INSERT INTO worker_accounts (id, provider, ready) VALUES (?, 'codex', 1)").run(id);
    await nativeCodexLogin(stateDir, id, identity);
  }
  config.close();
  store.close();
  // Stand in for the workers API so removing a signed-in Worker can drain it.
  const drained: string[] = [];
  await mkdir(join(stateDir, "sockets"), { recursive: true, mode: 0o700 });
  const workersApi = createServer((socket) => socket.on("data", (chunk) => {
    const { id, params } = JSON.parse(chunk.toString("utf8")) as { id: number; params: { arguments: { id: string } } };
    drained.push(params.arguments.id);
    socket.end(`${JSON.stringify({ id, result: { structuredContent: {} } })}\n`);
  }));
  await new Promise<void>((resolve) => workersApi.listen(join(stateDir, "sockets", "worker.sock"), resolve));
  const served = await serveApi({ name: "auth", transport: "socket", env: { ...process.env, AGENTSTACK_STATE_DIR: stateDir } });
  const request = (name: string, args: Record<string, unknown> = {}) => call(served.socketPath ?? "", name, args);
  type Listed = { accounts: Array<{ id: string; ready?: boolean; linkedAccounts: Array<{ scope: string; id: string }> }> };
  const workers = async () => (await request("worker_account_list") as Listed).accounts;
  const pairOf = async (bot: string) => (await request("account_list") as Listed).accounts.find((account) => account.id === bot)?.linkedAccounts;
  try {
    // An older Worker joins the Bot with its login; a Bot without one gets a Worker awaiting sign-in.
    assert.deepEqual(await pairOf(matching.id), [{ scope: "worker", id: olderWorker }]);
    const [created] = (await pairOf(unmatched.id))!;
    assert.equal((await workers()).find((account) => account.id === created?.id)?.ready, false);
    assert.deepEqual((await workers()).find((account) => account.id === strayWorker)?.linkedAccounts, []);
    // Codex Workers are never added on their own, and a paired one leaves only with its Bot.
    await assert.rejects(request("worker_account_prepare", { provider: "codex" }), /come with Codex Bot accounts/);
    await assert.rejects(request("worker_account_login_start", { provider: "codex" }), /come with Codex Bot accounts/);
    await assert.rejects(request("worker_account_remove", { id: olderWorker }), /removed with its Codex Bot account/);
    await request("worker_account_remove", { id: strayWorker });
    // A paired Worker must sign in to its Bot's login.
    await request("worker_account_prepare", { provider: "codex", id: created!.id });
    await nativeCodexLogin(stateDir, created!.id, "someone-else");
    await assert.rejects(request("worker_account_confirm", { id: created!.id }), /does not match its paired Bot account/);
    await nativeCodexLogin(stateDir, created!.id, "native-b");
    assert.equal((await request("worker_account_confirm", { id: created!.id }) as { ready: boolean }).ready, true);
    const listed = JSON.stringify({ bots: await request("account_list"), workers: await workers() });
    for (const secret of ["native-a", "native-b", "worker-refresh", "worker-access"]) assert.equal(listed.includes(secret), false);
    // Removing a Bot account removes its paired Worker and that Worker's profile.
    const [doomed] = (await pairOf(removed.id))!;
    await request("account_remove", { id: removed.id });
    assert.equal((await workers()).some((account) => account.id === doomed?.id), false);
    await assert.rejects(stat(accountRoot(stateDir, doomed!.id)), /ENOENT/);
    assert.equal((await workers()).length, 2);
    assert.deepEqual(drained, [strayWorker]);
  } finally { await served.close(); workersApi.close(); await rm(stateDir, { recursive: true, force: true }); }
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
