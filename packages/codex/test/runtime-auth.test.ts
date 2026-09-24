import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RuntimeAuth } from "../src/runtime-auth.js";
import { Supervisor } from "../src/supervisor.js";
import { StateStore, type StoredServer } from "../src/store.js";

const auth = (stamp: string, token: string) => JSON.stringify({ last_refresh: stamp, tokens: { refresh_token: token, access_token: "access", id_token: "fixture.jwt.signature", account_id: "one" } });

test("watcher imports a completed refresh and recovery catches one missed while offline", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-runtime-watch-"));
  const store = new StateStore(root);
  const monitor = new RuntimeAuth(store);
  try {
    const accountId = store.addAccount(auth("2026-09-23T10:00:00Z", "first")).id;
    const runtimeRoot = await monitor.prepare("watched");
    const home = join(runtimeRoot, "codex-runtime");
    await mkdir(home);
    const file = join(home, "auth.json");
    await writeFile(file, store.activeAccount().auth);
    const record: StoredServer = { id: "watched", pid: 1, cwd: root, url: "ws://127.0.0.1:40001", state: "running", codexBin: "codex", account: accountId, authVersion: 1, runtimeRoot, mainThreadId: "thread-watched", threadStarting: false };
    store.saveServer(record);
    await monitor.watch(record);
    await writeFile(file, '{"tokens":'); // A watcher event can arrive during a truncate/write.
    await new Promise((resolve) => setTimeout(resolve, 30));
    await writeFile(file, auth("2026-09-23T11:00:00Z", "second"));
    for (let i = 0; i < 50 && store.activeAccount().version === 1; i += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(store.activeAccount().auth, auth("2026-09-23T11:00:00Z", "second"));
    assert.equal(store.servers()[0]?.authVersion, 2);

    await monitor.close(); // Simulate the owner not observing the next write.
    await writeFile(file, auth("2026-09-23T12:00:00Z", "third"));
    const recovered = new RuntimeAuth(store);
    assert.equal(await recovered.reconcile(record), "updated");
    assert.equal(store.activeAccount().auth, auth("2026-09-23T12:00:00Z", "third"));
    await recovered.finish(record);
    assert.equal(record.runtimeRoot, null);
    await assert.rejects(readFile(file), /ENOENT/);
  } finally { await monitor.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("a superseded runtime is retained for diagnosis without blocking the next generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-runtime-superseded-"));
  const store = new StateStore(root);
  const monitor = new RuntimeAuth(store);
  try {
    const old = auth("2026-09-23T10:00:00Z", "first");
    const accountId = store.addAccount(old).id;
    const runtimeRoot = await monitor.prepare("bound");
    const home = join(runtimeRoot, "codex-runtime");
    await mkdir(home);
    await writeFile(join(home, "auth.json"), old);
    const record: StoredServer = { id: "bound", pid: null, cwd: root, url: null, state: "stopped", codexBin: "codex", account: accountId, authVersion: 1, runtimeRoot, mainThreadId: "thread-bound", threadStarting: false };
    store.saveServer(record);
    const replacement = auth("2026-09-23T11:00:00Z", "signed-in-again");
    store.replaceCredentials(accountId, replacement);
    const status = await monitor.finish(record);
    assert.equal(status, "stale");
    assert.equal(await monitor.retireSuperseded(record, status), true);
    assert.equal(record.runtimeRoot, null);
    assert.equal(store.servers()[0]?.runtimeRoot, null);
    assert.equal(store.accountCredentials(accountId).auth, replacement);
    const archived = await readdir(join(root, "runtime-recovery", "bound"));
    assert.equal(archived.length, 1);
    assert.equal(await readFile(join(root, "runtime-recovery", "bound", archived[0]!, "codex-runtime", "auth.json"), "utf8"), old);
    await assert.rejects(readFile(join(home, "auth.json")), /ENOENT/);
    const supervisor = new Supervisor({ stateDir: root, store });
    await supervisor.load();
    await supervisor.remove("bound");
    await assert.rejects(readdir(join(root, "runtime-recovery", "bound")), /ENOENT/);
  } finally { await monitor.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});
