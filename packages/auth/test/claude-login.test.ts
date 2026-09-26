import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { workerAccountRemove, type AuthContext } from "../api.js";
import { AuthStore } from "../src/store.js";
import { WorkerLoginManager, type WorkerLoginState } from "../src/worker-login.js";
import { accountRoot, prepareAccountProfile } from "../src/worker-accounts.js";
import { claudeConfigRoot } from "../src/claude-credentials.js";

const fixture = fileURLToPath(new URL("../../test/fixtures/fake-worker-login-claude.mjs", import.meta.url));
const fileOnly = { platform: "linux" as const };
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
async function wait(login: WorkerLoginManager, id: string, accept: (state: WorkerLoginState) => boolean) {
  for (let i = 0; i < 200; i++) {
    const state = login.status(id);
    if (accept(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`sign-in did not reach expected state: ${JSON.stringify(login.status(id))}`);
}

for (const native of [false, true]) {
  for (const outcome of ["submit", "cancel", "remove", "failure"] as const) {
    test(`Claude ${native ? "default macOS" : "fixture"} login copies its URL and supports ${outcome}`, { skip: native && process.platform !== "darwin", timeout: 15_000 }, async () => {
      const root = await mkdtemp(join(tmpdir(), "agentstack-claude-login-"));
      const store = new AuthStore(root);
      const bin = join(root, "fake claude's cli");
      await writeFile(bin, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fixture)} "$@"\n`, { mode: 0o700 });
      const login = new WorkerLoginManager(store, { claude: fileOnly,
        env: { ...process.env, AGENTSTACK_CLAUDE_BIN: bin, FAKE_CLAUDE_NATIVE: native ? "1" : "",
          FAKE_CLAUDE_FAIL: outcome === "failure" ? "1" : "", ANTHROPIC_API_KEY: "ambient-secret", CLAUDE_CODE_OAUTH_TOKEN: "ambient-secret",
          CLAUDE_SECURESTORAGE_CONFIG_DIR: "", AWS_ACCESS_KEY_ID: "ambient-secret", GOOGLE_APPLICATION_CREDENTIALS: "/shared" },
        ...(native ? {} : { command: () => ({ bin: process.execPath, args: [fixture] }) }),
      });
      const changes: string[] = [];
      login.onChange = () => changes.push(JSON.stringify(login.current()));
      try {
        const account = store.prepareWorker("claude");
        await prepareAccountProfile(root, account, fileOnly);
        const started = await login.start(account);
        const shown = await wait(login, started.id, (state) => state.needsCode);
        assert.equal(shown.provider, "claude");
        assert.match(shown.authUrl!, /^https:\/\/claude\.com\/cai\/oauth\/authorize\?/);
        assert.equal(shown.userCode, null);
        assert.deepEqual(login.current(), [shown]);
        const marker = JSON.parse(await readFile(join(claudeConfigRoot(root, account.id), "fixture-marker.json"), "utf8"));
        assert.equal(marker.home, accountRoot(root, account.id));
        assert.equal(marker.config, claudeConfigRoot(root, account.id));
        assert.equal(marker.bypass, "1");
        assert.equal(marker.browser, "/usr/bin/true");
        assert.deepEqual(marker.leaked, []);
        if (native) {
          assert.equal(marker.openError, "EPERM");
          assert.deepEqual(marker.args, ["auth", "login", "--claudeai"]);
        }
        if (outcome === "cancel") await login.cancel(started.id);
        else if (outcome === "remove") {
          const ctx = { store, workerLogin: login, claude: fileOnly, onWorkerAccountsChanged: undefined } as AuthContext;
          await workerAccountRemove.call(ctx, { id: account.id });
          await assert.rejects(stat(accountRoot(root, account.id)), { code: "ENOENT" });
          assert.equal(store.workerAccounts().length, 0);
        } else {
          for (const invalid of ["", "bad\ncode", "bad\rcode", "x".repeat(4097)]) assert.throws(() => login.submit(started.id, invalid), /invalid sign-in code/);
          assert.equal(login.submit(started.id, "fixture-code#fixture-state").needsCode, false);
        }
        const result = await wait(login, started.id, (state) => state.status !== "pending");
        assert.equal(result.status, outcome === "submit" ? "complete" : "failed");
        assert.equal(result.authUrl, null);
        assert.equal(result.needsCode, false);
        assert.equal(store.workerAccounts()[0]?.ready ?? false, outcome === "submit");
        await login.close();
        for (const pid of [marker.pid, marker.descendant]) {
          for (let i = 0; i < 100; i++) {
            try { process.kill(pid, 0); } catch { break; }
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
        }
        for (const value of [...changes, JSON.stringify(result)]) {
          assert.equal(value.includes("private-fixture-token"), false);
          assert.equal(value.includes("fixture-code#"), false);
          assert.equal(value.includes("ambient-secret"), false);
        }
      } finally { await login.close(); store.close(); await rm(root, { recursive: true, force: true }); }
    });
  }
}

test("Claude refuses unrelated and credential-bearing URLs and supersedes only its own account", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-claude-url-"));
  const store = new AuthStore(root);
  const login = new WorkerLoginManager(store, { claude: fileOnly, env: { ...process.env,
    FAKE_CLAUDE_URL: "https://claude.com/cai/oauth/authorize?response_type=code&state=fixture&code_challenge=fixture&access_token=secret" },
    command: () => ({ bin: process.execPath, args: [fixture] }) });
  try {
    const a = store.prepareWorker("claude"), b = store.prepareWorker("claude");
    for (const account of [a, b]) await prepareAccountProfile(root, account, fileOnly);
    const one = await login.start(a), other = await login.start(b);
    const replacement = await login.start(a);
    assert.equal(login.status(one.id).status, "failed");
    assert.deepEqual(login.current().map((state) => state.id).sort(), [other.id, replacement.id].sort());
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(login.status(replacement.id).authUrl, null);
    assert.equal(login.status(replacement.id).needsCode, false);
    assert.throws(() => login.submit(replacement.id, "secret"), /not waiting/);
    await login.cancelAccount(a.id);
    assert.equal(login.status(other.id).status, "pending");
  } finally { await login.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("parallel Claude starts stay account-bound and cancellation reaps a descendant that outlives its leader", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-claude-descendant-"));
  const store = new AuthStore(root);
  const login = new WorkerLoginManager(store, { claude: fileOnly,
    env: { ...process.env, FAKE_CLAUDE_STUBBORN_DESCENDANT: "1" }, command: () => ({ bin: process.execPath, args: [fixture] }) });
  try {
    const account = store.prepareWorker("claude");
    await prepareAccountProfile(root, account, fileOnly);
    const starts = await Promise.all([login.start(account), login.start(account), login.start(account)]);
    assert.deepEqual(login.current().map((state) => state.id), [starts[2]!.id]);
    assert.ok(starts.slice(0, 2).every((state) => login.status(state.id).status === "failed"));
    await wait(login, starts[2]!.id, (state) => state.needsCode);
    const marker = JSON.parse(await readFile(join(claudeConfigRoot(root, account.id), "fixture-marker.json"), "utf8"));
    await login.cancel(starts[2]!.id);
    assert.equal(store.workerAccounts()[0]?.ready, false);
    for (const pid of [marker.pid, marker.descendant]) {
      for (let i = 0; i < 100; i++) {
        try { process.kill(pid, 0); } catch { break; }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    }
  } finally { await login.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});

test("cancellation fences delayed Claude credential confirmation after native login exits", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-claude-late-confirm-"));
  const store = new AuthStore(root);
  let release: () => void = () => undefined, reading: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { reading = resolve; });
  const login = new WorkerLoginManager(store, { command: () => ({ bin: process.execPath, args: [fixture] }),
    claude: { platform: "darwin", security: async () => { reading(); await gate; return { code: 44, stdout: "" }; } } });
  try {
    const account = store.prepareWorker("claude");
    await prepareAccountProfile(root, account, fileOnly);
    const started = await login.start(account);
    await wait(login, started.id, (state) => state.needsCode);
    login.submit(started.id, "fixture-code#fixture-state");
    await entered;
    const cancelled = login.cancel(started.id);
    release();
    await cancelled;
    assert.equal(login.status(started.id).status, "failed");
    assert.equal(store.workerAccounts()[0]?.ready, false);
  } finally { release(); await login.close(); store.close(); await rm(root, { recursive: true, force: true }); }
});
