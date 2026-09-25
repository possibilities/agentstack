import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { serveApi, socketCall, socketSubscribe } from "@agentstack/api";

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
        accounts_changed: "Published when an account signs in, is prepared, confirmed, enabled, disabled or removed. Refresh account_list.",
        login_changed: "Published when a Codex device sign-in starts, shows its prompt, is superseded or cancelled, or finishes. Never carries the prompt or credentials.",
      },
      subscribe: "events/subscribe",
    });
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      ["account_list", "account_set_enabled", "account_remove", "account_login_start", "account_login_replace", "account_login_status", "account_login_current", "account_login_cancel",
        "worker_account_prepare", "worker_account_confirm"],
    );

    await assert.rejects(socketCall(served.socketPath, "events/subscribe", { topics: [] }), /non-empty/);
    await assert.rejects(socketCall(served.socketPath, "events/subscribe", { topics: ["bogus"] }), /unknown topic/);
    await assert.rejects(socketCall(served.socketPath, "events/subscribe", { topics: ["accounts_changed", "accounts_changed"] }), /duplicate topic/);
    await assert.rejects(socketCall(served.socketPath, "events/subscribe", {}), /non-empty/);

    const subscription = await socketSubscribe(served.socketPath ?? "", ["accounts_changed", "login_changed"], (topic) => events.push(topic));
    assert.deepEqual([...subscription.topics].sort(), ["accounts_changed", "login_changed"]);

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
    assert.deepEqual(await call(served.socketPath, "account_list"), { accounts: [{ id: firstId, provider: "codex", enabled: true, ready: false, removing: false }] });

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
    assert.deepEqual(await call(served.socketPath, "account_set_enabled", { id: firstId, enabled: false }), { id: firstId, provider: "codex", enabled: false, ready: false, removing: false });
    assert.deepEqual(await call(served.socketPath, "account_remove", { id: firstId }), { accounts: [{ id: secondId, provider: "codex", enabled: true, ready: false, removing: false }] });
    await assert.rejects(call(served.socketPath, "account_set_enabled", { id: firstId, enabled: true }), /unknown/);
    await assert.rejects(socketCall(served.socketPath, "tools/call", { name: "server_list", arguments: {} }), /unknown operation/);

    for (let i = 0; i < 100 && !events.includes("accounts_changed"); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(events.includes("login_changed"));
    assert.ok(events.includes("accounts_changed"));

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
