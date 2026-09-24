import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { StateStore, type StoredServer } from "../src/store.js";
import { Supervisor, type LaunchSpec } from "../src/supervisor.js";
import { runningTree } from "../src/tree.js";

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

test("an existing unbound server stays unbound until assign, then the next start uses that account", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-unbound-"));
  const cwd = await mkdtemp(join(tmpdir(), "agentstack-cwd-"));
  const store = new StateStore(root);
  const observed: Array<string | null> = [];
  try {
    const supervisor = new Supervisor({ stateDir: root, store, graceMs: 20,
      endpoint: async () => "ws://127.0.0.1:45503",
      launch(spec) {
        const identity = spec.args[spec.args.indexOf("--identity") + 1]!;
        assert.equal(spec.env.CODEX_HOME, undefined);
        assert.ok(spec.args.includes("--capabilities") && spec.args.includes("--history-dir"));
        try { observed.push(readFileSync(join(identity, "auth.json"), "utf8")); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          observed.push(null);
        }
        let resolveExit: (code: number | null) => void = () => undefined;
        const exited = new Promise<number | null>((resolve) => { resolveExit = resolve; });
        return { pid: 200 + observed.length, exited, kill() { resolveExit(0); } };
      },
      waitReady: async () => undefined,
      bindThread: async (_url, _cwd, id) => id ?? "thread-unbound",
    });
    await supervisor.load();
    const started = await supervisor.start({ cwd, id: "open" });
    assert.equal(started.account, null);
    assert.equal(started.state, "running");
    assert.equal(started.mainThreadId, null);
    assert.deepEqual(observed, [null]);
    await writeFile(join(root, "runtime", "open", "leftover"), "runtime");
    await supervisor.stop("open");
    const again = await supervisor.start({ cwd, id: "open" });
    assert.equal(again.account, null);
    assert.equal(again.mainThreadId, started.mainThreadId);
    const account = store.addAccount(credential("later"));
    const stillUnbound = await supervisor.start({ cwd, id: "open" });
    assert.equal(stillUnbound.account, null);
    assert.equal(stillUnbound.pid, again.pid);
    const saveServer = store.saveServer.bind(store);
    try {
      store.saveServer = () => { throw new Error("database unavailable"); };
      await assert.rejects(supervisor.assign("open", account.id), /database unavailable/);
      assert.equal(supervisor.list()[0]?.account, null);
    } finally { store.saveServer = saveServer; }
    const assigned = await supervisor.assign("open", account.id);
    assert.equal(assigned.account, account.id);
    assert.equal(assigned.runningAccount, null);
    assert.equal((await runningTree(() => supervisor.list())).servers[0]?.account, null);
    await assert.rejects(supervisor.start({ cwd, id: "open" }), /different Codex account/);
    assert.equal(supervisor.list().find((server) => server.id === "open")?.pid, again.pid);
    await supervisor.stop("open");
    const bound = await supervisor.start({ cwd, id: "open" });
    assert.equal(bound.account, account.id);
    assert.equal(bound.runningAccount, account.id);
    assert.equal(bound.mainThreadId, started.mainThreadId);
    assert.equal(observed.at(-1), credential("later"));
    const other = store.addAccount(credential("other"));
    const reassigned = await supervisor.assign("open", other.id);
    assert.equal(reassigned.runningAccount, account.id);
    assert.equal((await runningTree(() => supervisor.list())).servers[0]?.account, account.id);
    await assert.rejects(supervisor.start({ cwd, id: "open" }), /different Codex account/);
    assert.equal((await supervisor.stop("open")).runningAccount, null);
    const rebound = await supervisor.start({ cwd, id: "open" });
    assert.equal(rebound.account, other.id);
    assert.equal(rebound.runningAccount, other.id);
    assert.equal(observed.at(-1), credential("other"));
    await assert.rejects(supervisor.assign("missing", account.id), /unknown server/);
    await assert.rejects(supervisor.assign("open", "00000000-0000-4000-8000-000000000000"), /unknown Codex account/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); await rm(cwd, { recursive: true, force: true }); }
});

test("upgrading a stopped Server reconciles its retained runtime against the last launched account", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-stopped-upgrade-"));
  const auth = (stamp: string, token: string) => JSON.stringify({
    last_refresh: stamp, tokens: { refresh_token: token, access_token: "access", id_token: "fixture.jwt.signature" },
  });
  try {
    const original = new StateStore(root);
    const account = original.addAccount(auth("2026-09-23T10:00:00Z", "old"));
    const runtimeRoot = join(root, "runtime", "stopped");
    const home = join(runtimeRoot, "codex-runtime");
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "auth.json"), auth("2026-09-23T11:00:00Z", "refreshed"));
    original.saveServer({
      id: "stopped", pid: null, cwd: root, url: null, state: "stopped", codexBin: "codex", account: account.id,
      launchedAccount: account.id, authVersion: 1, runtimeRoot, mainThreadId: "thread-stopped", threadStarting: false, args: [],
    });
    original.close();
    const config = new DatabaseSync(join(root, "configuration.sqlite"));
    config.exec("ALTER TABLE servers DROP COLUMN launched_account");
    config.close();

    const supervisor = new Supervisor({ stateDir: root });
    try {
      await supervisor.load();
      assert.equal(supervisor.store.servers()[0]?.launchedAccount, account.id);
      await supervisor.reap();
      assert.equal(supervisor.store.accountCredentials(account.id).auth, auth("2026-09-23T11:00:00Z", "refreshed"));
      assert.equal(supervisor.store.servers()[0]?.runtimeRoot, null);
    } finally { supervisor.store.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("existing SQLite state gains runtime and credential generations without losing accounts", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-schema-upgrade-"));
  try {
    const first = new StateStore(root);
    const accountId = first.addAccount(credential("before-upgrade")).id;
    first.close();
    const config = new DatabaseSync(join(root, "configuration.sqlite"));
    config.exec("ALTER TABLE servers DROP COLUMN auth_version; ALTER TABLE servers DROP COLUMN runtime_root; ALTER TABLE servers DROP COLUMN main_thread_id; ALTER TABLE servers DROP COLUMN thread_starting; ALTER TABLE servers DROP COLUMN launched_account");
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
    assert.deepEqual(upgraded.servers()[0]?.args, []);
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
    assert.equal(supervisor.store.servers().find((server) => server.id === "old")?.launchedAccount, id);
    assert.deepEqual(supervisor.store.servers().find((server) => server.id === "old")?.args, []);
    const orphan = supervisor.list().find((server) => server.id === "orphan")?.account;
    assert.match(orphan ?? "", /^[0-9a-f-]{36}$/);
    assert.notEqual(orphan, id);
    await supervisor.remove("orphan");
    assert.equal(supervisor.store.resolveLegacyAccount("codex-9"), "codex-9");
    supervisor.store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Server launch arguments persist only in private secrets storage and are removed with the Server", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-private-args-"));
  const store = new StateStore(root);
  const args = ["-c", "provider_token=private-example", "--model", "gpt-5.4"];
  try {
    const account = store.addAccount(credential("account"));
    const record: StoredServer = { id: "private", pid: null, cwd: root, url: null, state: "stopped", codexBin: "codex", account: account.id, launchedAccount: null, authVersion: null, runtimeRoot: null, mainThreadId: null, threadStarting: false, args };
    store.saveServer(record);
    assert.deepEqual(store.servers()[0]?.args, args);
    assert.equal(readFileSync(join(root, "configuration.sqlite")).includes(Buffer.from("provider_token=private-example")), false);
    assert.equal(readFileSync(join(root, "secrets.sqlite")).includes(Buffer.from("provider_token=private-example")), true);
    assert.throws(() => store.saveServer({ ...record, id: "invalid", account: "missing" }), /account is unavailable/i);
    assert.equal(store.servers().some(({ id }) => id === "invalid"), false);
    const secrets = new DatabaseSync(join(root, "secrets.sqlite"));
    assert.equal(secrets.prepare("SELECT 1 FROM server_args WHERE id = 'invalid'").get(), undefined);
    secrets.close();
    store.deleteServer(record.id);
    assert.deepEqual(store.servers(), []);
    const after = new DatabaseSync(join(root, "secrets.sqlite"));
    assert.equal(after.prepare("SELECT 1 FROM server_args WHERE id = 'private'").get(), undefined);
    after.close();
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
