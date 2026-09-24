import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { StateStore } from "../src/store.js";
import { Supervisor, type LaunchSpec } from "../src/supervisor.js";
import { LoginManager } from "../src/login.js";
import { fileURLToPath } from "node:url";

const credential = (token: string) => JSON.stringify({ tokens: { refresh_token: token, access_token: "access", id_token: "fixture.jwt.signature" } });

test("accounts are monotonic, selectable, and stored separately from configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-accounts-"));
  try {
    const store = new StateStore(root);
    assert.deepEqual(store.listAccounts(), []);
    assert.equal(store.addAccount(credential("first-secret")).name, "codex-1");
    assert.equal(store.addAccount(credential("second-secret")).name, "codex-2");
    assert.deepEqual(store.listAccounts(), [{ name: "codex-1", active: true }, { name: "codex-2", active: false }]);
    store.activate("codex-2");
    assert.equal(store.activeAccount().auth, credential("second-secret"));
    store.replaceCredentials("codex-2", credential("replacement-secret"));
    assert.equal(store.activeAccount().auth, credential("replacement-secret"));
    store.removeAccount("codex-1");
    assert.equal(store.addAccount(credential("third-secret")).name, "codex-3");
    assert.throws(() => store.activate("codex-1"), /unknown/);
    assert.throws(() => store.addAccount("{}"), /ChatGPT credentials/);
    store.close();

    const reopened = new StateStore(root);
    assert.deepEqual(reopened.listAccounts(), [{ name: "codex-2", active: true }, { name: "codex-3", active: false }]);
    reopened.removeAccount("codex-2");
    assert.deepEqual(reopened.listAccounts(), [{ name: "codex-3", active: true }]);
    reopened.close();
    assert.equal((await stat(join(root, "configuration.sqlite"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(root, "secrets.sqlite"))).mode & 0o777, 0o600);
    assert.equal((await readFile(join(root, "configuration.sqlite"))).includes(Buffer.from("first-secret")), false);
    assert.equal((await readFile(join(root, "configuration.sqlite"))).includes(Buffer.from("second-secret")), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a server snapshots its account at launch and never falls back to ambient Codex auth", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-axes-"));
  const cwd = await mkdtemp(join(tmpdir(), "agentstack-cwd-"));
  const store = new StateStore(root);
  const observed: Array<{ spec: LaunchSpec; auth: string }> = [];
  try {
    store.addAccount(credential("first-secret"));
    store.addAccount(credential("second-secret"));
    const supervisor = new Supervisor({ stateDir: root, store, graceMs: 20,
      endpoint: async (id) => `ws://127.0.0.1:${id === "one" ? 45501 : 45502}`,
      launch(spec) {
        // The identity exists only long enough for codexnk to copy it into its private runtime.
        const identity = spec.args[spec.args.indexOf("--identity") + 1];
        const auth = requireAuth(identity);
        observed.push({ spec, auth });
        let resolveExit: (code: number | null) => void = () => undefined;
        const exited = new Promise<number | null>((resolve) => { resolveExit = resolve; });
        return { pid: 100 + observed.length, exited, kill() { resolveExit(0); } };
      },
      waitReady: async () => undefined,
      bindThread: async (_url, _cwd, id) => id ?? `thread-${observed.length}`,
    });
    await supervisor.load();
    const first = await supervisor.start({ cwd, id: "one" });
    store.activate("codex-2");
    const second = await supervisor.start({ cwd, id: "two" });
    assert.deepEqual([first.account, second.account], ["codex-1", "codex-2"]);
    assert.deepEqual(observed.map(({ auth }) => auth), [credential("first-secret"), credential("second-secret")]);
    assert.deepEqual(observed.map(({ spec }) => spec.env.CODEX_HOME), [undefined, undefined]);
    assert.deepEqual(observed.map(({ spec }) => spec.env.TMPDIR), [join(root, "runtime", "one"), join(root, "runtime", "two")]);
    assert.equal((await supervisor.start({ cwd, id: "one" })).account, "codex-1");
    assert.equal(supervisor.list().find((server) => server.id === "two")?.account, "codex-2");
    await supervisor.stop("one");
    const resumed = await supervisor.start({ cwd, id: "one" });
    assert.equal(resumed.account, "codex-1");
    assert.equal(resumed.mainThreadId, first.mainThreadId);
    assert.equal(observed.at(-1)?.auth, credential("first-secret"));
  } finally { store.close(); await rm(root, { recursive: true, force: true }); await rm(cwd, { recursive: true, force: true }); }
});

function requireAuth(identity: string): string {
  return readFileSync(join(identity, "auth.json"), "utf8");
}

async function settle(login: LoginManager, id: string) {
  let result = login.status(id);
  for (let i = 0; i < 200 && result.status === "pending"; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    result = login.status(id);
  }
  return result;
}

async function prompted(login: LoginManager, id: string) {
  let result = login.status(id);
  for (let i = 0; i < 200 && result.status === "pending" && !result.authUrl; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    result = login.status(id);
  }
  return result;
}

test("device login imports only finished credentials into the secrets database", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-login-"));
  const store = new StateStore(root);
  const fixture = fileURLToPath(new URL("../../test/fixtures/fake-login.mjs", import.meta.url));
  const login = new LoginManager(store, { bin: process.execPath, args: [fixture] });
  try {
    const started = await login.start();
    assert.equal(started.status, "pending");
    assert.equal(started.targetAccount, null);
    assert.deepEqual(store.listAccounts(), []);
    const shown = await prompted(login, started.id);
    assert.equal(shown.authUrl, "https://auth.openai.com/codex/device");
    assert.equal(shown.userCode, "ABCD-EFGH");
    assert.deepEqual(login.current(), shown);
    const result = await settle(login, started.id);
    assert.equal(result.status, "complete");
    assert.equal(result.account, "codex-1");
    assert.equal(result.authUrl, null);
    assert.equal(result.userCode, null);
    assert.equal(login.current(), null);
    assert.equal(store.activeAccount().auth, credential("fixture-secret"));
    const replacement = await login.start("codex-1");
    assert.equal(replacement.targetAccount, "codex-1");
    const updated = await settle(login, replacement.id);
    assert.equal(updated.status, "complete");
    assert.equal(updated.authUrl, null);
    assert.equal(updated.userCode, null);
    assert.deepEqual(store.listAccounts(), [{ name: "codex-1", active: true }]);
  } finally { await login.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("a new sign-in supersedes a pending attempt and never imports cancelled credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-login-restart-"));
  const store = new StateStore(root);
  const fixture = fileURLToPath(new URL("../../test/fixtures/fake-login.mjs", import.meta.url));
  const login = new LoginManager(store, { bin: process.execPath, args: [fixture] });
  const savedHang = process.env.FAKE_LOGIN_HANG;
  process.env.FAKE_LOGIN_HANG = "1";
  try {
    const first = await login.start();
    const shown = await prompted(login, first.id);
    assert.equal(shown.status, "pending");
    assert.equal(shown.userCode, "ABCD-EFGH");
    await new Promise((resolve) => setTimeout(resolve, 150));
    const second = await login.start();
    assert.notEqual(second.id, first.id);
    assert.equal(login.current()?.id, second.id);
    assert.equal((await settle(login, first.id)).status, "failed");
    assert.match(login.status(first.id).error ?? "", /new attempt/);
    assert.deepEqual(store.listAccounts(), []);
    login.cancel(second.id);
    const third = await login.start();
    assert.notEqual(third.id, second.id);
    assert.equal((await settle(login, second.id)).status, "failed");
    assert.equal(login.status(second.id).error, "Sign-in cancelled");
    assert.equal(login.current()?.id, third.id);
    assert.deepEqual(store.listAccounts(), []);
  } finally {
    if (savedHang === undefined) delete process.env.FAKE_LOGIN_HANG;
    else process.env.FAKE_LOGIN_HANG = savedHang;
    await login.close(); store.close(); await rm(root, { recursive: true, force: true });
  }
});

test("a cancelled sign-in ignores delayed prompt output and never imports", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-login-delayed-"));
  const store = new StateStore(root);
  const fixture = fileURLToPath(new URL("../../test/fixtures/fake-login.mjs", import.meta.url));
  const login = new LoginManager(store, { bin: process.execPath, args: [fixture] });
  const savedDelayed = process.env.FAKE_LOGIN_DELAYED;
  process.env.FAKE_LOGIN_DELAYED = "1";
  try {
    const started = await login.start();
    let directory: string | null = null;
    for (let i = 0; i < 200 && !directory; i += 1) {
      for (const name of await readdir(root)) {
        if (name.startsWith(".login-") && await stat(join(root, name, "ready")).then(() => true, () => false)) directory = join(root, name);
      }
      if (!directory) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(directory);
    login.cancel(started.id);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const mid = login.status(started.id);
    assert.equal(mid.status, "failed");
    assert.equal(mid.authUrl, null);
    assert.equal(mid.userCode, null);
    await login.close();
    const result = login.status(started.id);
    assert.equal(result.status, "failed");
    assert.equal(result.error, "Sign-in cancelled");
    assert.equal(result.authUrl, null);
    assert.equal(result.userCode, null);
    assert.deepEqual(store.listAccounts(), []);
    assert.equal(login.current(), null);
  } finally {
    if (savedDelayed === undefined) delete process.env.FAKE_LOGIN_DELAYED;
    else process.env.FAKE_LOGIN_DELAYED = savedDelayed;
    await login.close(); store.close(); await rm(root, { recursive: true, force: true });
  }
});

test("closing during an unfinished sign-in marks it failed and never imports", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-login-close-"));
  const store = new StateStore(root);
  const fixture = fileURLToPath(new URL("../../test/fixtures/fake-login.mjs", import.meta.url));
  const login = new LoginManager(store, { bin: process.execPath, args: [fixture] });
  const savedHang = process.env.FAKE_LOGIN_HANG;
  process.env.FAKE_LOGIN_HANG = "1";
  try {
    const started = await login.start();
    await prompted(login, started.id);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await login.close();
    const result = login.status(started.id);
    assert.equal(result.status, "failed");
    assert.equal(result.authUrl, null);
    assert.equal(result.userCode, null);
    assert.deepEqual(store.listAccounts(), []);
    assert.equal(login.current(), null);
  } finally {
    if (savedHang === undefined) delete process.env.FAKE_LOGIN_HANG;
    else process.env.FAKE_LOGIN_HANG = savedHang;
    await login.close(); store.close(); await rm(root, { recursive: true, force: true });
  }
});

test("a sign-in that ignores SIGTERM is force-killed within the bounded fallback", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-login-stubborn-"));
  const store = new StateStore(root);
  const fixture = fileURLToPath(new URL("../../test/fixtures/fake-login.mjs", import.meta.url));
  const login = new LoginManager(store, { bin: process.execPath, args: [fixture] });
  const savedStubborn = process.env.FAKE_LOGIN_STUBBORN;
  process.env.FAKE_LOGIN_STUBBORN = "1";
  try {
    const started = await login.start();
    await prompted(login, started.id);
    const began = Date.now();
    await login.close();
    assert.ok(Date.now() - began < 15_000);
    const result = login.status(started.id);
    assert.equal(result.status, "failed");
    assert.equal(result.authUrl, null);
    assert.equal(result.userCode, null);
    assert.deepEqual(store.listAccounts(), []);
  } finally {
    if (savedStubborn === undefined) delete process.env.FAKE_LOGIN_STUBBORN;
    else process.env.FAKE_LOGIN_STUBBORN = savedStubborn;
    await login.close(); store.close(); await rm(root, { recursive: true, force: true });
  }
});

test("parallel sign-in starts are linearized so only one attempt stays pending", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-login-parallel-"));
  const store = new StateStore(root);
  const fixture = fileURLToPath(new URL("../../test/fixtures/fake-login.mjs", import.meta.url));
  const login = new LoginManager(store, { bin: process.execPath, args: [fixture] });
  const savedHang = process.env.FAKE_LOGIN_HANG;
  process.env.FAKE_LOGIN_HANG = "1";
  try {
    const [first, second] = await Promise.all([login.start(), login.start()]);
    assert.notEqual(first.id, second.id);
    assert.equal((await settle(login, first.id)).status, "failed");
    assert.equal(login.current()?.id, second.id);
    assert.deepEqual(store.listAccounts(), []);
  } finally {
    if (savedHang === undefined) delete process.env.FAKE_LOGIN_HANG;
    else process.env.FAKE_LOGIN_HANG = savedHang;
    await login.close(); store.close(); await rm(root, { recursive: true, force: true });
  }
});

test("refreshed credentials advance only on a strictly newer timestamp and matching launch generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-credential-order-"));
  const store = new StateStore(root);
  const auth = (stamp: string, token: string, accountId = "provider-account") => JSON.stringify({
    last_refresh: stamp, tokens: { refresh_token: token, access_token: "access", id_token: "fixture.jwt.signature", account_id: accountId },
  });
  try {
    store.addAccount(auth("2026-09-23T10:00:00Z", "original"));
    assert.deepEqual(store.syncCredential("codex-1", 1, auth("2026-09-23T11:00:00Z", "updated")), { status: "updated", version: 2 });
    assert.deepEqual(store.syncCredential("codex-1", 1, auth("2026-09-23T12:00:00Z", "competing")), { status: "stale", version: 2 });
    assert.deepEqual(store.syncCredential("codex-1", 2, auth("2026-09-23T09:00:00Z", "older")), { status: "stale", version: 2 });
    assert.deepEqual(store.syncCredential("codex-1", 2, auth("2026-09-23T11:00:00Z", "different")), { status: "stale", version: 2 });
    assert.deepEqual(store.syncCredential("codex-1", 2, auth("2026-09-23T13:00:00Z", "wrong-account", "another")), { status: "invalid", version: 2 });
    assert.deepEqual(store.syncCredential("codex-1", 2, '{"tokens":'), { status: "invalid", version: null });
    assert.equal(store.activeAccount().auth, auth("2026-09-23T11:00:00Z", "updated"));
    store.replaceCredentials("codex-1", auth("2026-09-23T14:00:00Z", "signed-in-again"));
    assert.deepEqual(store.syncCredential("codex-1", 2, auth("2026-09-23T15:00:00Z", "old-runtime")), { status: "stale", version: 3 });
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("a missing timestamp cannot establish that a runtime credential is newer", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-no-timestamp-"));
  const store = new StateStore(root);
  try {
    const original = credential("original");
    store.addAccount(original);
    assert.deepEqual(store.syncCredential("codex-1", 1, JSON.stringify({
      last_refresh: "2026-09-23T12:00:00Z",
      tokens: { refresh_token: "candidate", access_token: "access", id_token: "fixture.jwt.signature" },
    })), { status: "stale", version: 1 });
    assert.equal(store.activeAccount().auth, original);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("existing SQLite state gains runtime and credential generations without losing accounts", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-schema-upgrade-"));
  try {
    const first = new StateStore(root);
    first.addAccount(credential("before-upgrade"));
    first.close();
    const config = new DatabaseSync(join(root, "configuration.sqlite"));
    config.exec("ALTER TABLE servers DROP COLUMN auth_version; ALTER TABLE servers DROP COLUMN runtime_root; ALTER TABLE servers DROP COLUMN main_thread_id; ALTER TABLE servers DROP COLUMN thread_starting");
    config.prepare("INSERT INTO servers (id, pid, cwd, url, state, codex_bin, account) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("old", null, root, null, "stopped", "codex", "codex-1");
    config.close();
    const secrets = new DatabaseSync(join(root, "secrets.sqlite"));
    secrets.exec("ALTER TABLE credentials DROP COLUMN version");
    secrets.close();
    const upgraded = new StateStore(root);
    assert.equal(upgraded.activeAccount().auth, credential("before-upgrade"));
    assert.equal(upgraded.activeAccount().version, 1);
    assert.equal(upgraded.servers()[0]?.mainThreadId, null);
    assert.equal(upgraded.servers()[0]?.threadStarting, false);
    upgraded.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
