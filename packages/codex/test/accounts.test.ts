import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
