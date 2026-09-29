import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { LoginManager } from "../src/login.js";
import { AuthStore } from "../src/store.js";

const fakeLogin = fileURLToPath(new URL("../../test/fixtures/fake-login.mjs", import.meta.url));

test("a duplicate completed device sign-in reports a safe failure without changing inventory", async () => {
  const root = await mkdtemp(join(tmpdir(), "stack-duplicate-login-"));
  const previousIdentity = process.env.FAKE_LOGIN_NATIVE_ID;
  process.env.FAKE_LOGIN_NATIVE_ID = "already-registered";
  const store = new AuthStore(root);
  const manager = new LoginManager(store, { bin: process.execPath, args: [fakeLogin] });
  try {
    const first = store.addAccount(JSON.stringify({ tokens: { refresh_token: "original", access_token: "access", id_token: "fixture.jwt.signature", account_id: "already-registered" } }));
    const changed: string[] = [];
    manager.onAccountsChange = () => changed.push("accounts");
    manager.onChange = () => changed.push("login");
    const attempt = await manager.start();
    let result = manager.status(attempt.id);
    for (let i = 0; i < 100 && result.status === "pending"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      result = manager.status(attempt.id);
    }
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /already registered.*Sign in again/);
    assert.equal(result.account, null);
    assert.deepEqual(store.listAccounts().map((account) => account.id), [first.id]);
    assert.equal(store.workerAccounts().length, 1);
    assert.equal(changed.includes("accounts"), false);
    assert.ok(changed.includes("login"));
    assert.equal(JSON.stringify(result).includes("already-registered"), false);
  } finally {
    await manager.close();
    store.close();
    if (previousIdentity === undefined) delete process.env.FAKE_LOGIN_NATIVE_ID;
    else process.env.FAKE_LOGIN_NATIVE_ID = previousIdentity;
    await rm(root, { recursive: true, force: true });
  }
});
