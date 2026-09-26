import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AuthStore } from "../src/store.js";
import { WorkerLoginManager, type WorkerLoginState } from "../src/worker-login.js";
import { accountRoot, prepareAccountProfile } from "../src/worker-accounts.js";

const fixtures = {
  codex: fileURLToPath(new URL("../../test/fixtures/fake-worker-login-codex.mjs", import.meta.url)),
  grok: fileURLToPath(new URL("../../test/fixtures/fake-worker-login-grok.mjs", import.meta.url)),
  devin: fileURLToPath(new URL("../../test/fixtures/fake-worker-login-devin.mjs", import.meta.url)),
};

type Provider = keyof typeof fixtures;

const commandFor = (provider: Provider) => () => ({ bin: process.execPath, args: [fixtures[provider]] });

async function readyAccount(store: AuthStore, provider: Provider) {
  const account = store.prepareWorker(provider);
  await prepareAccountProfile(store.stateDir, account);
  return account;
}

async function settle(login: WorkerLoginManager, id: string): Promise<WorkerLoginState> {
  let result = login.status(id);
  for (let i = 0; i < 200 && result.status === "pending"; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    result = login.status(id);
  }
  return result;
}

async function prompted(login: WorkerLoginManager, id: string): Promise<WorkerLoginState> {
  let result = login.status(id);
  for (let i = 0; i < 200 && result.status === "pending" && !result.authUrl; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    result = login.status(id);
  }
  return result;
}

function env(overrides: Record<string, string>): NodeJS.ProcessEnv {
  return { ...process.env, ...overrides };
}

async function harness(provider: Provider, overrides: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), `agentstack-worker-login-${provider}-`));
  const store = new AuthStore(root);
  const login = new WorkerLoginManager(store, { env: env(overrides), command: commandFor(provider) });
  const seen: string[] = [];
  login.onChange = () => { seen.push(JSON.stringify(login.current())); };
  const account = await readyAccount(store, provider);
  return { root, store, login, account, seen };
}

test("codex sign-in surfaces only the link and code, then confirms the account ready", async () => {
  const { root, store, login, account, seen } = await harness("codex");
  try {
    const started = await login.start(account);
    assert.equal(started.status, "pending");
    assert.equal(started.account, account.id);
    assert.equal(started.provider, "codex");
    const shown = await prompted(login, started.id);
    assert.equal(shown.authUrl, "https://auth.openai.com/codex/device");
    assert.equal(shown.userCode, "FAKE-C0DEX");
    assert.equal(shown.needsCode, false);
    assert.deepEqual(login.current(), [shown]);
    const result = await settle(login, started.id);
    assert.equal(result.status, "complete");
    assert.equal(result.authUrl, null);
    assert.equal(result.userCode, null);
    assert.equal(store.workerAccounts().find((item) => item.id === account.id)?.ready, true);
    assert.deepEqual(login.current(), []);
    for (const entry of seen) {
      assert.ok(!entry.includes("fake-codex-secret"));
      assert.ok(!entry.includes("refresh_token"));
    }
  } finally { await login.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("grok sign-in surfaces the prefilled link and code, then confirms ready", async () => {
  const { root, store, login, account } = await harness("grok");
  try {
    const started = await login.start(account);
    const shown = await prompted(login, started.id);
    assert.equal(shown.authUrl, "https://accounts.x.ai/oauth2/device?user_code=FAKE-XAIC");
    assert.equal(shown.userCode, "FAKE-XAIC");
    const result = await settle(login, started.id);
    assert.equal(result.status, "complete");
    assert.equal(store.workerAccounts().find((item) => item.id === account.id)?.ready, true);
  } finally { await login.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("devin sign-in shows its link, rejects then accepts pasted codes, then confirms ready", async () => {
  const { root, store, login, account } = await harness("devin");
  try {
    const started = await login.start(account);
    const shown = await prompted(login, started.id);
    assert.match(shown.authUrl ?? "", /^https:\/\/app\.devin\.ai\/auth\/cli\/continue\?/);
    assert.equal(shown.needsCode, true);
    assert.equal(shown.userCode, null);
    const rejected = login.submit(started.id, "bad-code");
    assert.equal(rejected.needsCode, false);
    assert.equal(rejected.status, "pending");
    // The rejection re-arms the field with a friendly error; the attempt stays pending.
    let state = login.status(started.id);
    for (let i = 0; i < 100 && !state.needsCode; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      state = login.status(started.id);
    }
    assert.equal(state.needsCode, true);
    assert.equal(state.error, "Devin didn't accept that code. Paste it again.");
    const accepted = login.submit(started.id, "good-code");
    assert.equal(accepted.needsCode, false);
    assert.equal(accepted.error, null);
    const result = await settle(login, started.id);
    assert.equal(result.status, "complete");
    assert.equal(store.workerAccounts().find((item) => item.id === account.id)?.ready, true);
  } finally { await login.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("a non-zero exit fails the attempt and never confirms the account", async () => {
  const { root, store, login, account } = await harness("codex", { FAKE_WORKER_LOGIN_FAIL: "1" });
  try {
    const started = await login.start(account);
    await prompted(login, started.id);
    const result = await settle(login, started.id);
    assert.equal(result.status, "failed");
    assert.equal(result.error, "Codex sign-in did not finish. Try again.");
    assert.equal(result.authUrl, null);
    assert.equal(store.workerAccounts().find((item) => item.id === account.id)?.ready, false);
  } finally { await login.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("cancel marks the attempt failed and kills the native sign-in", async () => {
  const { root, store, login, account } = await harness("codex", { FAKE_WORKER_LOGIN_HANG: "1" });
  try {
    const started = await login.start(account);
    await prompted(login, started.id);
    login.cancel(started.id);
    const result = await settle(login, started.id);
    assert.equal(result.status, "failed");
    assert.equal(result.error, "Sign-in cancelled");
    assert.equal(result.authUrl, null);
    assert.equal(result.userCode, null);
    assert.deepEqual(login.current(), []);
    assert.equal(store.workerAccounts().find((item) => item.id === account.id)?.ready, false);
  } finally { await login.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("restarting one account's sign-in supersedes it without touching another account's", async () => {
  const { root, store, login, account } = await harness("grok", { FAKE_WORKER_LOGIN_HANG: "1" });
  try {
    const other = await readyAccount(store, "grok");
    const first = await login.start(account);
    const third = await login.start(other);
    const second = await login.start(account);
    assert.notEqual(second.id, first.id);
    const superseded = await settle(login, first.id);
    assert.equal(superseded.status, "failed");
    assert.match(superseded.error ?? "", /new attempt/);
    assert.deepEqual(login.current().map((item) => item.id).sort(), [second.id, third.id].sort());
    login.cancel(second.id);
    login.cancel(third.id);
  } finally { await login.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("submit is rejected outside a devin attempt awaiting a code", async () => {
  const { root, store, login, account } = await harness("codex", { FAKE_WORKER_LOGIN_HANG: "1" });
  const delayed = await harness("devin", { FAKE_WORKER_LOGIN_DELAYED: "1" });
  try {
    const codex = await login.start(account);
    await prompted(login, codex.id);
    assert.throws(() => login.submit(codex.id, "code"), /not waiting for a code/);
    const devin = await delayed.login.start(delayed.account);
    assert.throws(() => delayed.login.submit(devin.id, "code"), /not waiting for a code/);
    assert.throws(() => delayed.login.submit("missing", "code"), /unknown Worker sign-in/);
    const shown = await prompted(delayed.login, devin.id);
    assert.equal(shown.needsCode, true);
    for (const bad of ["", "x".repeat(4097), "bad\ncode", "bad\rcode"])
      assert.throws(() => delayed.login.submit(devin.id, bad), /invalid sign-in code/);
    delayed.login.cancel(devin.id);
    await settle(delayed.login, devin.id);
    login.cancel(codex.id);
    await settle(login, codex.id);
  } finally {
    await login.close();
    await delayed.login.close();
    store.close();
    delayed.store.close();
    await rm(root, { recursive: true, force: true });
    await rm(delayed.root, { recursive: true, force: true });
  }
});

test("duplicate native credentials fail with the store's rejection", async () => {
  const { root, store, login, account } = await harness("codex");
  try {
    const other = await readyAccount(store, "codex");
    const first = await login.start(account);
    assert.equal((await settle(login, first.id)).status, "complete");
    const next = await login.start(other);
    const result = await settle(login, next.id);
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /another worker account/);
    assert.equal(store.workerAccounts().find((item) => item.id === other.id)?.ready, false);
  } finally {
    await login.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("close marks an unfinished sign-in failed", async () => {
  const { root, store, login, account } = await harness("grok", { FAKE_WORKER_LOGIN_HANG: "1" });
  try {
    const started = await login.start(account);
    await prompted(login, started.id);
    await login.close();
    const result = login.status(started.id);
    assert.equal(result.status, "failed");
    assert.equal(result.error, "Worker sign-in stopped");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("cancelAccount terminates a pending sign-in so removal never leaves a live child", async () => {
  const { root, store, login, account } = await harness("codex", { FAKE_WORKER_LOGIN_HANG: "1" });
  try {
    const started = await login.start(account);
    await prompted(login, started.id);
    await login.cancelAccount(account.id);
    const result = login.status(started.id);
    assert.equal(result.status, "failed");
    assert.equal(result.error, "Sign-in cancelled");
    assert.deepEqual(login.current(), []);
  } finally { await login.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("only the devin child is marked remote so its browser launch stays suppressed", async () => {
  for (const provider of ["devin", "codex", "grok"] as const) {
    const { root, store, login, account } = await harness(provider, { FAKE_WORKER_LOGIN_HANG: provider === "devin" ? "" : "1" });
    try {
      const started = await login.start(account);
      await prompted(login, started.id);
      const marker = readFileSync(join(accountRoot(store.stateDir, account.id), "data", "env-marker"), "utf8");
      assert.equal(marker, provider === "devin" ? "ssh:set" : "ssh:unset");
      login.cancel(started.id);
      await settle(login, started.id);
    } finally { await login.close(); store.close(); await rm(root, { recursive: true, force: true }); }
  }
});
