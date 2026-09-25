import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AuthStore } from "../src/store.js";

const credential = (token: string) => JSON.stringify({ tokens: { refresh_token: token, access_token: "access", id_token: "fixture.jwt.signature" } });

test("accounts have stable IDs, can be disabled, and store credentials separately", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-accounts-"));
  try {
    const store = new AuthStore(root);
    assert.deepEqual(store.listAccounts(), []);
    const first = store.addAccount(credential("first-secret"));
    const second = store.addAccount(credential("second-secret"));
    assert.match(first.id, /^[0-9a-f-]{36}$/);
    assert.notEqual(first.id, second.id);
    assert.deepEqual(store.listAccounts(), [first, second]);
    store.setEnabled(first.id, false);
    assert.equal(store.listAccounts()[0]?.enabled, false);
    assert.equal(store.accountCredentials(second.id).auth, credential("second-secret"));
    store.replaceCredentials(second.id, credential("replacement-secret"));
    assert.equal(store.accountCredentials(second.id).auth, credential("replacement-secret"));
    store.removeAccount(first.id);
    const third = store.addAccount(credential("third-secret"));
    assert.notEqual(third.id, first.id);
    assert.throws(() => store.setEnabled(first.id, true), /unknown/);
    assert.throws(() => store.addAccount("{}"), /ChatGPT credentials/);
    store.close();

    const reopened = new AuthStore(root);
    assert.deepEqual(reopened.listAccounts(), [second, third]);
    reopened.removeAccount(second.id);
    assert.deepEqual(reopened.listAccounts(), [third]);
    reopened.close();
    assert.equal((await stat(join(root, "configuration.sqlite"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(root, "secrets.sqlite"))).mode & 0o777, 0o600);
    assert.equal((await readFile(join(root, "configuration.sqlite"))).includes(Buffer.from("first-secret")), false);
    assert.equal((await readFile(join(root, "configuration.sqlite"))).includes(Buffer.from("second-secret")), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("legacy ordinal references migrate atomically across credentials and Server bindings", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-account-migration-"));
  try {
    const store = new AuthStore(root);
    const original = store.addAccount(credential("legacy-secret"));
    store.close();
    const config = new DatabaseSync(join(root, "configuration.sqlite"));
    const secrets = new DatabaseSync(join(root, "secrets.sqlite"));
    config.prepare("UPDATE accounts SET name = 'codex-1' WHERE name = ?").run(original.id);
    config.exec("ALTER TABLE accounts DROP COLUMN removing");
    config.prepare("INSERT INTO settings (key, value) VALUES ('active_account', 'codex-1')").run();
    config.exec("CREATE TABLE servers (id TEXT PRIMARY KEY, account TEXT)");
    config.prepare("INSERT INTO servers VALUES ('bound', 'codex-1')").run();
    secrets.prepare("UPDATE credentials SET name = 'codex-1' WHERE name = ?").run(original.id);
    config.close();
    secrets.close();

    const migrated = new AuthStore(root);
    const account = migrated.listAccounts()[0]!;
    assert.notEqual(account.id, "codex-1");
    const migratedConfig = new DatabaseSync(join(root, "configuration.sqlite"));
    assert.equal(migratedConfig.prepare("SELECT 1 FROM settings WHERE key = 'active_account'").get(), undefined);
    migratedConfig.close();
    assert.equal(migrated.accountCredentials(account.id).id, account.id);
    assert.equal(migrated.accountCredentials(account.id).auth, credential("legacy-secret"));
    assert.equal(migrated.resolveLegacyAccount("codex-1"), account.id);
    assert.deepEqual(migrated.boundServerIds(account.id), ["bound"]);
    migrated.beginRemoval(account.id);
    assert.throws(() => migrated.accountCredentials(account.id), /unavailable/);
    assert.throws(() => migrated.removeAccount(account.id), /bound bots/);
    const writable = new DatabaseSync(join(root, "configuration.sqlite"));
    writable.prepare("DELETE FROM servers WHERE id = 'bound'").run();
    writable.close();
    migrated.removeAccount(account.id);
    assert.deepEqual(migrated.listAccounts(), []);
    assert.equal(migrated.resolveLegacyAccount("codex-1"), "codex-1");
    migrated.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an account cannot be removed while a Server last launched with it awaits another assignment", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-pending-removal-"));
  const store = new AuthStore(root);
  try {
    const launched = store.addAccount(credential("launched"));
    const assigned = store.addAccount(credential("assigned"));
    const config = new DatabaseSync(join(root, "configuration.sqlite"));
    config.exec("CREATE TABLE servers (id TEXT PRIMARY KEY, account TEXT, launched_account TEXT)");
    config.prepare("INSERT INTO servers VALUES ('pending', ?, ?)").run(assigned.id, launched.id);
    config.close();
    assert.deepEqual(store.boundServerIds(launched.id), ["pending"]);
    assert.deepEqual(store.boundServerIds(assigned.id), ["pending"]);
    assert.throws(() => store.removeAccount(launched.id), /bound bots/);
    assert.equal(store.listAccounts().find(({ id }) => id === launched.id)?.removing, true);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("refreshed credentials advance only on a strictly newer timestamp and matching launch generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-credential-order-"));
  const store = new AuthStore(root);
  const auth = (stamp: string, token: string, accountId = "provider-account") => JSON.stringify({
    last_refresh: stamp, tokens: { refresh_token: token, access_token: "access", id_token: "fixture.jwt.signature", account_id: accountId },
  });
  try {
    const id = store.addAccount(auth("2026-09-23T10:00:00Z", "original")).id;
    assert.deepEqual(store.syncCredential(id, 1, auth("2026-09-23T11:00:00Z", "updated")), { status: "updated", version: 2 });
    assert.deepEqual(store.syncCredential(id, 1, auth("2026-09-23T12:00:00Z", "competing")), { status: "stale", version: 2 });
    assert.deepEqual(store.syncCredential(id, 2, auth("2026-09-23T09:00:00Z", "older")), { status: "stale", version: 2 });
    assert.deepEqual(store.syncCredential(id, 2, auth("2026-09-23T11:00:00Z", "different")), { status: "stale", version: 2 });
    assert.deepEqual(store.syncCredential(id, 2, auth("2026-09-23T13:00:00Z", "wrong-account", "another")), { status: "invalid", version: 2 });
    assert.deepEqual(store.syncCredential(id, 2, '{"tokens":'), { status: "invalid", version: null });
    assert.equal(store.accountCredentials(id).auth, auth("2026-09-23T11:00:00Z", "updated"));
    store.replaceCredentials(id, auth("2026-09-23T14:00:00Z", "signed-in-again"));
    assert.deepEqual(store.syncCredential(id, 2, auth("2026-09-23T15:00:00Z", "old-runtime")), { status: "stale", version: 3 });
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("a missing timestamp cannot establish that a runtime credential is newer", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-no-timestamp-"));
  const store = new AuthStore(root);
  try {
    const original = credential("original");
    const id = store.addAccount(original).id;
    assert.deepEqual(store.syncCredential(id, 1, JSON.stringify({
      last_refresh: "2026-09-23T12:00:00Z",
      tokens: { refresh_token: "candidate", access_token: "access", id_token: "fixture.jwt.signature" },
    })), { status: "stale", version: 1 });
    assert.equal(store.accountCredentials(id).auth, original);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("a second auth store connection sees committed accounts and fences stale refresh generations", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-auth-shared-"));
  const writer = new AuthStore(root);
  const reader = new AuthStore(root);
  const auth = (stamp: string, token: string) => JSON.stringify({
    last_refresh: stamp, tokens: { refresh_token: token, access_token: "access", id_token: "fixture.jwt.signature", account_id: "provider-account" },
  });
  try {
    const first = writer.addAccount(auth("2026-09-23T10:00:00Z", "original"));
    const second = writer.addAccount(auth("2026-09-23T10:00:00Z", "other"));
    writer.setEnabled(first.id, false);
    assert.deepEqual(reader.listAccounts(), [{ id: first.id, enabled: false, removing: false }, { id: second.id, enabled: true, removing: false }]);
    assert.equal(reader.accountCredentials(second.id).auth, auth("2026-09-23T10:00:00Z", "other"));
    writer.replaceCredentials(second.id, auth("2026-09-23T12:00:00Z", "replaced"));
    assert.equal(reader.accountCredentials(second.id).version, 2);
    assert.deepEqual(reader.syncCredential(second.id, 1, auth("2026-09-23T13:00:00Z", "stale-refresh")), { status: "stale", version: 2 });
    assert.deepEqual(reader.syncCredential(second.id, 2, auth("2026-09-23T13:00:00Z", "fresh-refresh")), { status: "updated", version: 3 });
    assert.equal(writer.accountCredentials(second.id).auth, auth("2026-09-23T13:00:00Z", "fresh-refresh"));
    writer.removeAccount(first.id);
    assert.deepEqual(reader.listAccounts(), [{ id: second.id, enabled: true, removing: false }]);
  } finally { writer.close(); reader.close(); await rm(root, { recursive: true, force: true }); }
});

test("concurrent fresh stores in separate processes initialize shared databases without SQLITE_BUSY", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-auth-race-"));
  const storePath = fileURLToPath(new URL("../src/store.js", import.meta.url));
  const script = `
    import { AuthStore } from ${JSON.stringify(storePath)};
    const store = new AuthStore(process.argv[1]);
    store.addAccount(${JSON.stringify(JSON.stringify({ tokens: { refresh_token: "t", access_token: "a", id_token: "i" } }))});
    store.close();
  `;
  try {
    for (let round = 0; round < 5; round += 1) {
      const dir = join(root, `round-${round}`);
      const children = Array.from({ length: 4 }, () =>
        spawn(process.execPath, ["--input-type=module", "-e", script, dir], { stdio: ["ignore", "pipe", "pipe"] }),
      );
      const results = await Promise.all(children.map((child) => new Promise<{ code: number | null; stderr: string }>((resolve) => {
        let stderr = "";
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
        child.once("exit", (code) => resolve({ code, stderr }));
      })));
      for (const result of results) assert.equal(result.code, 0, result.stderr);
      const store = new AuthStore(dir);
      assert.equal(store.listAccounts().length, 4);
      store.close();
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
