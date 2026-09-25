import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { AuthStore } from "../src/store.js";
import { accountEnvironment, accountRoot, credentialEvidence, loginCommand, prepareAccountProfile } from "../src/worker-accounts.js";

test("two native account profiles keep sign-ins and configuration separate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentstack-worker-accounts-"));
  const store = new AuthStore(dir);
  try {
    const a = store.prepareWorker("grok");
    const b = store.prepareWorker("grok");
    const devin = store.prepareWorker("devin");
    for (const account of [a, b, devin]) await prepareAccountProfile(dir, account);
    const envA = accountEnvironment(dir, a, { XAI_API_KEY: "ambient", OPENCODE_CONFIG_CONTENT: "ambient", HOME: dir });
    const envB = accountEnvironment(dir, b, { XAI_API_KEY: "ambient" });
    assert.notEqual(envA.XDG_DATA_HOME, envB.XDG_DATA_HOME);
    assert.equal(envA.XAI_API_KEY, undefined);
    assert.equal(envA.OPENCODE_CONFIG_CONTENT, undefined);
    assert.match(await readFile(envA.OPENCODE_CONFIG!, "utf8"), /"xai"/);
    assert.match(loginCommand(dir, devin), /devin auth login/);
    const fakeBin = join(dir, "fake-bin");
    await mkdir(fakeBin);
    await writeFile(join(fakeBin, "devin"), '#!/bin/sh\nmkdir -p "$XDG_DATA_HOME/devin"\n: > "$XDG_DATA_HOME/devin/credentials.toml"\n', { mode: 0o755 });
    execFileSync("/bin/sh", ["-c", loginCommand(dir, devin)], { env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` }, timeout: 5_000 });
    assert.equal((await stat(join(accountRoot(dir, devin.id), "data", "devin", "credentials.toml"))).mode & 0o777, 0o600);
    assert.match(loginCommand(dir, a), /opencode' auth login --standalone xai/);
    assert.equal((await stat(accountRoot(dir, a.id))).mode & 0o777, 0o700);
    for (const [account, secret] of [[a, "first"], [b, "second"]] as const) {
      const folder = join(accountRoot(dir, account.id), "data", "opencode");
      await mkdir(folder, { recursive: true });
      const path = join(folder, "opencode.db");
      const db = new DatabaseSync(path);
      db.exec("CREATE TABLE credential (integration_id TEXT, value TEXT)");
      db.prepare("INSERT INTO credential VALUES (?, ?)").run("xai", JSON.stringify({ type: "oauth", access: secret, refresh: secret }));
      db.close();
      await chmod(path, 0o600);
      store.confirmWorker(account.id, (await credentialEvidence(dir, account)).digest);
    }
    assert.equal(store.workerAccounts().filter((account) => account.provider === "grok" && account.ready).length, 2);
    const duplicate = (await credentialEvidence(dir, a)).digest;
    assert.throws(() => store.confirmWorker(b.id, duplicate), /another worker account/);
    const codex = store.addAccount(JSON.stringify({ tokens: { refresh_token: "refresh", access_token: "access",
      id_token: "fixture.jwt.signature", account_id: "matching-account" } }));
    const bound = store.prepareWorker("codex");
    assert.notEqual(bound.id, codex.id);
    assert.throws(() => store.prepareWorker("codex", codex.id), /unknown worker account/);
    await prepareAccountProfile(dir, bound);
    const codexPath = join(accountRoot(dir, bound.id), "data", "opencode", "opencode.db");
    await mkdir(join(accountRoot(dir, bound.id), "data", "opencode"), { recursive: true });
    const db = new DatabaseSync(codexPath);
    db.exec("CREATE TABLE credential (integration_id TEXT, value TEXT)");
    db.prepare("INSERT INTO credential VALUES (?, ?)").run("openai", JSON.stringify({ type: "oauth", access: "codex", refresh: "codex", metadata: { accountID: "matching-account" } }));
    db.close();
    await chmod(codexPath, 0o600);
    assert.equal((await credentialEvidence(dir, bound)).identity, "matching-account");
    store.confirmWorker(bound.id, (await credentialEvidence(dir, bound)).digest);
    store.setEnabled(codex.id, false);
    assert.equal(store.workerAccounts().find((account) => account.id === bound.id)?.enabled, true);
    store.removeAccount(codex.id);
    assert.equal(store.workerAccounts().find((account) => account.id === bound.id)?.ready, true);
    assert.equal(store.listAccounts().length, 0);
    store.enableWorker(a.id, false);
    assert.equal(store.workerAccounts().find((account) => account.id === a.id)?.enabled, false);
    store.beginWorkerRemoval(a.id);
    assert.equal(store.workerAccounts().find((account) => account.id === a.id)?.removing, true);
    store.finishWorkerRemoval(a.id);
    assert.equal(store.workerAccounts().some((account) => account.id === a.id), false);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
