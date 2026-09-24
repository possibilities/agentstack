import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AuthStore } from "../src/store.js";
import { LoginManager } from "../src/login.js";

const credential = (token: string) => JSON.stringify({ tokens: { refresh_token: token, access_token: "access", id_token: "fixture.jwt.signature" } });
const fixture = fileURLToPath(new URL("../../test/fixtures/fake-login.mjs", import.meta.url));

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
  const store = new AuthStore(root);
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
    assert.equal(result.account, store.listAccounts()[0]?.id);
    assert.equal(result.authUrl, null);
    assert.equal(result.userCode, null);
    assert.equal(login.current(), null);
    assert.equal(store.activeAccount().auth, credential("fixture-secret"));
    const id = result.account!;
    const replacement = await login.start(id);
    assert.equal(replacement.targetAccount, id);
    const updated = await settle(login, replacement.id);
    assert.equal(updated.status, "complete");
    assert.equal(updated.authUrl, null);
    assert.equal(updated.userCode, null);
    assert.deepEqual(store.listAccounts(), [{ id, active: true, removing: false }]);
  } finally { await login.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("a new sign-in supersedes a pending attempt and never imports cancelled credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-login-restart-"));
  const store = new AuthStore(root);
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
  const store = new AuthStore(root);
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
  const store = new AuthStore(root);
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
  const store = new AuthStore(root);
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
  const store = new AuthStore(root);
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
