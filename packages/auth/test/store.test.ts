import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AuthStore } from "../src/store.js";

const credential = (token: string) => JSON.stringify({ tokens: { refresh_token: token, access_token: "access", id_token: "fixture.jwt.signature" } });

test("accounts are monotonic, selectable, and stored separately from configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-accounts-"));
  try {
    const store = new AuthStore(root);
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

    const reopened = new AuthStore(root);
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

test("refreshed credentials advance only on a strictly newer timestamp and matching launch generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-credential-order-"));
  const store = new AuthStore(root);
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
  const store = new AuthStore(root);
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

test("a second auth store connection sees committed accounts and fences stale refresh generations", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-auth-shared-"));
  const writer = new AuthStore(root);
  const reader = new AuthStore(root);
  const auth = (stamp: string, token: string) => JSON.stringify({
    last_refresh: stamp, tokens: { refresh_token: token, access_token: "access", id_token: "fixture.jwt.signature", account_id: "provider-account" },
  });
  try {
    writer.addAccount(auth("2026-09-23T10:00:00Z", "original"));
    writer.addAccount(auth("2026-09-23T10:00:00Z", "other"));
    writer.activate("codex-2");
    assert.deepEqual(reader.listAccounts(), [{ name: "codex-1", active: false }, { name: "codex-2", active: true }]);
    assert.equal(reader.activeAccount().auth, auth("2026-09-23T10:00:00Z", "other"));
    writer.replaceCredentials("codex-2", auth("2026-09-23T12:00:00Z", "replaced"));
    assert.equal(reader.accountCredentials("codex-2").version, 2);
    assert.deepEqual(reader.syncCredential("codex-2", 1, auth("2026-09-23T13:00:00Z", "stale-refresh")), { status: "stale", version: 2 });
    assert.deepEqual(reader.syncCredential("codex-2", 2, auth("2026-09-23T13:00:00Z", "fresh-refresh")), { status: "updated", version: 3 });
    assert.equal(writer.activeAccount().auth, auth("2026-09-23T13:00:00Z", "fresh-refresh"));
    writer.removeAccount("codex-1");
    assert.deepEqual(reader.listAccounts(), [{ name: "codex-2", active: true }]);
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
