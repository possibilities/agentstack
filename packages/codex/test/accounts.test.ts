import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { StateStore } from "../src/store.js";
import { Supervisor, type LaunchSpec } from "../src/supervisor.js";

const credential = (token: string) => JSON.stringify({ tokens: { refresh_token: token, access_token: "access", id_token: "fixture.jwt.signature" } });

test("a server snapshots its account at launch and never falls back to ambient Codex auth", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-axes-"));
  const cwd = await mkdtemp(join(tmpdir(), "agentstack-cwd-"));
  const store = new StateStore(root);
  const observed: Array<{ spec: LaunchSpec; auth: string }> = [];
  try {
    const firstAccount = store.addAccount(credential("first-secret"));
    const secondAccount = store.addAccount(credential("second-secret"));
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
    store.activate(secondAccount.id);
    const second = await supervisor.start({ cwd, id: "two" });
    assert.deepEqual([first.account, second.account], [firstAccount.id, secondAccount.id]);
    assert.deepEqual(observed.map(({ auth }) => auth), [credential("first-secret"), credential("second-secret")]);
    assert.deepEqual(observed.map(({ spec }) => spec.env.CODEX_HOME), [undefined, undefined]);
    assert.deepEqual(observed.map(({ spec }) => spec.env.TMPDIR), [join(root, "runtime", "one"), join(root, "runtime", "two")]);
    assert.equal((await supervisor.start({ cwd, id: "one" })).account, firstAccount.id);
    assert.equal(supervisor.list().find((server) => server.id === "two")?.account, secondAccount.id);
    await supervisor.stop("one");
    const resumed = await supervisor.start({ cwd, id: "one" });
    assert.equal(resumed.account, firstAccount.id);
    assert.equal(resumed.mainThreadId, first.mainThreadId);
    assert.equal(observed.at(-1)?.auth, credential("first-secret"));
    await supervisor.remove("one");
    store.removeAccount(firstAccount.id);
    assert.deepEqual(store.listAccounts(), [{ id: secondAccount.id, active: true, removing: false }]);
    assert.equal(supervisor.list().find((server) => server.id === "two")?.account, secondAccount.id);
    assert.equal((await supervisor.start({ cwd, id: "two" })).account, secondAccount.id);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); await rm(cwd, { recursive: true, force: true }); }
});

function requireAuth(identity: string): string {
  return readFileSync(join(identity, "auth.json"), "utf8");
}

test("existing SQLite state gains runtime and credential generations without losing accounts", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-schema-upgrade-"));
  try {
    const first = new StateStore(root);
    const accountId = first.addAccount(credential("before-upgrade")).id;
    first.close();
    const config = new DatabaseSync(join(root, "configuration.sqlite"));
    config.exec("ALTER TABLE servers DROP COLUMN auth_version; ALTER TABLE servers DROP COLUMN runtime_root; ALTER TABLE servers DROP COLUMN main_thread_id; ALTER TABLE servers DROP COLUMN thread_starting");
    config.prepare("INSERT INTO servers (id, pid, cwd, url, state, codex_bin, account) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("old", null, root, null, "stopped", "codex", accountId);
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

test("legacy JSON Server records follow the migrated immutable account ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-json-account-upgrade-"));
  try {
    const initial = new StateStore(root);
    const before = initial.addAccount(credential("legacy"));
    initial.close();
    const config = new DatabaseSync(join(root, "configuration.sqlite"));
    const secrets = new DatabaseSync(join(root, "secrets.sqlite"));
    config.prepare("UPDATE accounts SET name = 'codex-1' WHERE name = ?").run(before.id);
    config.prepare("UPDATE settings SET value = 'codex-1' WHERE key = 'active_account'").run();
    secrets.prepare("UPDATE credentials SET name = 'codex-1' WHERE name = ?").run(before.id);
    config.close();
    secrets.close();
    await mkdir(join(root, "servers"));
    await writeFile(join(root, "servers", "old.json"), JSON.stringify({
      id: "old", pid: null, cwd: root, url: null, state: "stopped", codexBin: "codex", account: "codex-1",
    }));
    await writeFile(join(root, "servers", "orphan.json"), JSON.stringify({
      id: "orphan", pid: null, cwd: root, url: null, state: "stopped", codexBin: "codex", account: "codex-9",
    }));
    const supervisor = new Supervisor({ stateDir: root });
    await supervisor.load();
    const id = supervisor.store.listAccounts()[0]!.id;
    assert.notEqual(id, "codex-1");
    assert.equal(supervisor.list().find((server) => server.id === "old")?.account, id);
    assert.equal(supervisor.store.servers().find((server) => server.id === "old")?.account, id);
    const orphan = supervisor.list().find((server) => server.id === "orphan")?.account;
    assert.match(orphan ?? "", /^[0-9a-f-]{36}$/);
    assert.notEqual(orphan, id);
    await supervisor.remove("orphan");
    assert.equal(supervisor.store.resolveLegacyAccount("codex-9"), "codex-9");
    supervisor.store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
