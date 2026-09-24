import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    assert.equal((await stat(accountRoot(dir, a.id))).mode & 0o777, 0o700);
    for (const [account, secret] of [[a, "first"], [b, "second"]] as const) {
      const folder = join(accountRoot(dir, account.id), "data", "opencode");
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, "auth.json"), JSON.stringify({ xai: { type: "oauth", access: secret, refresh: secret } }), { mode: 0o600 });
      store.confirmWorker(account.id, (await credentialEvidence(dir, account)).digest);
    }
    assert.equal(store.workerAccounts().filter((account) => account.provider === "grok" && account.ready).length, 2);
    const duplicate = (await credentialEvidence(dir, a)).digest;
    assert.throws(() => store.confirmWorker(b.id, duplicate), /another worker account/);
    store.enableWorker(a.id, false);
    assert.equal(store.workerAccounts().find((account) => account.id === a.id)?.enabled, false);
    store.beginWorkerRemoval(a.id);
    assert.equal(store.workerAccounts().find((account) => account.id === a.id)?.removing, true);
    store.finishWorkerRemoval(a.id);
    assert.equal(store.workerAccounts().some((account) => account.id === a.id), false);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
