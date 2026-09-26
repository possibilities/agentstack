import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { AuthStore } from "../src/store.js";
import { accountEnvironment, accountRoot, credentialEvidence, loginCommand, prepareAccountProfile } from "../src/worker-accounts.js";
import { claudeConfigRoot, claudeKeychainAccount, claudeKeychainService, claudeRuntimePath, readClaudeCredentials, removeClaudeCredentials } from "../src/claude-credentials.js";

const fileOnly = { platform: "linux" as const };
const identityA = "10000000-0000-4000-8000-000000000001";
const identityB = "10000000-0000-4000-8000-000000000002";
const credential = (access: string) => ({ claudeAiOauth: { accessToken: access, refreshToken: `${access}-refresh`, scopes: ["user:inference"], expiresAt: 9999999999999 } });
async function fixture(root: string, id: string, identity: string, access: string) {
  const dir = claudeConfigRoot(root, id);
  await writeFile(join(dir, ".credentials.json"), JSON.stringify(credential(access)), { mode: 0o600 });
  await writeFile(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: identity, emailAddress: "fixture@example.invalid" } }), { mode: 0o600 });
}

test("Claude profiles isolate two native sign-ins, scrub ambient auth and bind reauthentication to identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-claude-accounts-"));
  const store = new AuthStore(root);
  try {
    const a = store.prepareWorker("claude"), b = store.prepareWorker("claude");
    for (const account of [a, b]) await prepareAccountProfile(root, account, fileOnly);
    const source = { HOME: "/original/home", AGENTSTACK_CLAUDE_BIN: ".local/bin/custom-claude", ANTHROPIC_API_KEY: "ambient",
      ANTHROPIC_CUSTOM_HEADERS: "ambient", ANTHROPIC_PROFILE: "ambient", CLAUDE_CONFIG_DIR: "/shared",
      CLAUDE_SECURESTORAGE_CONFIG_DIR: "", CLAUDE_CODE_OAUTH_TOKEN: "ambient", CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_HOST_CREDS_FILE: "/shared", CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: "3", CLAUDE_LOCAL_OAUTH_API_BASE: "https://bad.invalid",
      AWS_ACCESS_KEY_ID: "ambient", GOOGLE_APPLICATION_CREDENTIALS: "/shared", AZURE_API_KEY: "ambient", AGENTSTART_SHIM_BYPASS: "ambient" };
    const envA = accountEnvironment(root, a, source), envB = accountEnvironment(root, b, source);
    assert.notEqual(envA.CLAUDE_CONFIG_DIR, envB.CLAUDE_CONFIG_DIR);
    assert.notEqual(envA.HOME, envB.HOME);
    assert.equal(envA.AGENTSTACK_CLAUDE_BIN, "/original/home/.local/bin/custom-claude");
    assert.equal(claudeRuntimePath({ HOME: "/original/home", AGENTSTACK_CLAUDE_BIN: "~/tools/claude" }), "/original/home/tools/claude");
    assert.equal(envA.AGENTSTART_SHIM_BYPASS, "1");
    for (const key of Object.keys(source).filter((key) => /^(ANTHROPIC_|CLAUDE_|AWS_|GOOGLE_|AZURE_)/.test(key) && key !== "CLAUDE_CONFIG_DIR")) assert.equal(envA[key], undefined, key);
    assert.equal(envA.USER, claudeKeychainAccount());
    assert.equal((await stat(envA.CLAUDE_CONFIG_DIR!)).mode & 0o777, 0o700);
    assert.match(loginCommand(root, a), /'auth' 'login' '--claudeai'/);
    await fixture(root, a.id, identityA, "first");
    await fixture(root, b.id, identityB, "second");
    for (const account of [a, b]) {
      const evidence = await credentialEvidence(root, account, fileOnly);
      store.confirmWorker(account.id, evidence.digest, evidence.identity);
    }
    assert.equal(store.workerAccounts().filter((account) => account.ready).length, 2);
    assert.equal((await readClaudeCredentials(root, a.id, fileOnly)).access, "first");
    const prior = await credentialEvidence(root, a, fileOnly);
    store.prepareWorker("claude", a.id);
    assert.throws(() => store.confirmWorker(a.id, "rotated", identityB), /does not match/);
    assert.equal(store.workerAccounts().find((account) => account.id === a.id)?.ready, false);
    store.confirmWorker(a.id, "rotated", prior.identity);
    const c = store.prepareWorker("claude");
    assert.throws(() => store.confirmWorker(c.id, "other-token", identityA), /already bound/);
    store.enableWorker(a.id, false);
    assert.equal(store.workerAccounts().find((account) => account.id === b.id)?.enabled, true);
    const persisted = await readFile(join(root, "configuration.sqlite"));
    for (const secret of [identityA, identityB, "fixture@example.invalid", "first-refresh"]) assert.equal(persisted.includes(secret), false);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("Claude reads and deletes only its reserved keychain service and treats keychain errors as failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-claude-keychain-"));
  const store = new AuthStore(root);
  try {
    const account = store.prepareWorker("claude");
    const config = claudeConfigRoot(root, account.id), service = claudeKeychainService(config);
    const calls: string[][] = [];
    let code = 44;
    const options = { platform: "darwin" as const, security: async (args: string[]) => {
      calls.push(args); return { code, stdout: JSON.stringify(credential("keychain-token")) };
    } };
    await prepareAccountProfile(root, account, options);
    // Native `security` finds the default keychain under the account HOME.
    const keychains = join(accountRoot(root, account.id), "Library", "Keychains");
    assert.equal(await readlink(keychains), join(userInfo().homedir, "Library", "Keychains"));
    await prepareAccountProfile(root, account, options);
    assert.equal(await readlink(keychains), join(userInfo().homedir, "Library", "Keychains"));
    await fixture(root, account.id, identityA, "file-token");
    code = 0;
    assert.equal((await readClaudeCredentials(root, account.id, options)).access, "keychain-token");
    code = 44;
    assert.equal((await readClaudeCredentials(root, account.id, options)).access, "file-token");
    code = 1;
    await assert.rejects(readClaudeCredentials(root, account.id, options), /keychain is unavailable/);
    await assert.rejects(removeClaudeCredentials(root, account.id, options), /keychain is unavailable/);
    code = 0;
    await removeClaudeCredentials(root, account.id, options);
    assert.deepEqual(calls[0], ["find-generic-password", "-s", service]);
    assert.deepEqual(calls.at(-1), ["delete-generic-password", "-s", service, "-a", claudeKeychainAccount()]);
    assert.ok(calls.every((args) => args[args.indexOf("-s") + 1] === service));
    assert.equal(service, `Claude Code-credentials-${createHash("sha256").update(config.normalize("NFC")).digest("hex").slice(0, 8)}`);
    const collision = store.prepareWorker("claude");
    await assert.rejects(prepareAccountProfile(root, collision, options), /already occupied/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("Claude rejects unsafe native evidence without exposing the bytes or following links", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-claude-private-"));
  const store = new AuthStore(root);
  try {
    const account = store.prepareWorker("claude");
    await prepareAccountProfile(root, account, fileOnly);
    await fixture(root, account.id, identityA, "fixture-secret");
    const path = join(claudeConfigRoot(root, account.id), ".credentials.json");
    await chmod(path, 0o644);
    await assert.rejects(credentialEvidence(root, account, fileOnly), /not private/);
    await chmod(path, 0o600);
    await writeFile(path, '{"fixture-secret": broken');
    await assert.rejects(credentialEvidence(root, account, fileOnly), (error: Error) => !error.message.includes("fixture-secret"));
    await rm(path);
    await symlink(join(claudeConfigRoot(root, account.id), ".claude.json"), path);
    await assert.rejects(credentialEvidence(root, account, fileOnly), /unavailable/);
    await rm(claudeConfigRoot(root, account.id), { recursive: true });
    await symlink(accountRoot(root, account.id), claudeConfigRoot(root, account.id));
    await assert.rejects(prepareAccountProfile(root, account, fileOnly), /not private/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("auth migrates the prior Worker provider constraint without losing account state or ordering", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-claude-migrate-"));
  const db = new DatabaseSync(join(root, "configuration.sqlite"));
  db.exec("CREATE TABLE worker_accounts (id TEXT PRIMARY KEY, provider TEXT NOT NULL CHECK(provider IN ('codex','grok','devin')), enabled INTEGER NOT NULL DEFAULT 1, ready INTEGER NOT NULL DEFAULT 0, removing INTEGER NOT NULL DEFAULT 0, credential_digest TEXT)");
  db.prepare("INSERT INTO worker_accounts VALUES (?, 'grok', 0, 1, 1, 'prior-digest')").run(identityA);
  db.close();
  const store = new AuthStore(root);
  try {
    assert.deepEqual(store.workerAccounts(), [{ id: identityA, provider: "grok", enabled: false, ready: true, removing: true }]);
    const claude = store.prepareWorker("claude");
    assert.equal(store.workerAccounts()[1]?.id, claude.id);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
