import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
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
    const supervisor = new Supervisor({ stateDir: root, store,
      endpoint: async (id) => `ws://127.0.0.1:${id === "one" ? 45501 : 45502}`,
      launch(spec) {
        // The identity exists only long enough for codexnk to copy it into its private runtime.
        const identity = spec.args[spec.args.indexOf("--identity") + 1];
        const auth = requireAuth(identity);
        observed.push({ spec, auth });
        return { pid: 100 + observed.length, exited: new Promise(() => undefined), kill() {} };
      },
      waitReady: async () => undefined,
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
  } finally { store.close(); await rm(root, { recursive: true, force: true }); await rm(cwd, { recursive: true, force: true }); }
});

function requireAuth(identity: string): string {
  return readFileSync(join(identity, "auth.json"), "utf8");
}

test("browser login imports only finished credentials into the secrets database", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-login-"));
  const store = new StateStore(root);
  const fixture = fileURLToPath(new URL("../../test/fixtures/fake-login.mjs", import.meta.url));
  const login = new LoginManager(store, { bin: process.execPath, args: [fixture] });
  try {
    const started = await login.start();
    assert.equal(started.status, "pending");
    assert.deepEqual(store.listAccounts(), []);
    let result = login.status(started.id);
    for (let i = 0; i < 50 && result.status === "pending"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      result = login.status(started.id);
    }
    assert.equal(result.status, "complete");
    assert.equal(result.account, "codex-1");
    assert.equal(store.activeAccount().auth, credential("fixture-secret"));
    const replacement = await login.start("codex-1");
    let updated = login.status(replacement.id);
    for (let i = 0; i < 50 && updated.status === "pending"; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      updated = login.status(replacement.id);
    }
    assert.equal(updated.status, "complete");
    assert.deepEqual(store.listAccounts(), [{ name: "codex-1", active: true }]);
  } finally { await login.close(); store.close(); await rm(root, { recursive: true, force: true }); }
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
    config.exec("ALTER TABLE servers DROP COLUMN auth_version; ALTER TABLE servers DROP COLUMN runtime_root");
    config.close();
    const secrets = new DatabaseSync(join(root, "secrets.sqlite"));
    secrets.exec("ALTER TABLE credentials DROP COLUMN version");
    secrets.close();
    const upgraded = new StateStore(root);
    assert.equal(upgraded.activeAccount().auth, credential("before-upgrade"));
    assert.equal(upgraded.activeAccount().version, 1);
    assert.deepEqual(upgraded.servers(), []);
    upgraded.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
