import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AuthStore, claudeConfigRoot, claudeKeychainService, credentialEvidence, prepareAccountProfile } from "@agentstack/auth";
import { collectAccount, parseClaudeUsage } from "../src/collect.js";
import { UsageObserver } from "../src/observer.js";
import { claudeUsage, snapshotSchema } from "../src/schema.js";

const fileOnly = { platform: "linux" as const };
const body = (used = 24) => ({ five_hour: { utilization: used, resets_at: "2026-09-25T15:00:00+00:00" },
  seven_day: { utilization: 17, resets_at: "2026-09-30T00:00:00Z" }, seven_day_opus: null,
  seven_day_sonnet: { utilization: 125, resets_at: null },
  extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1225.5, utilization: 24.51 },
  private_provider_identity: "must-not-publish",
});
const creds = (token: string) => JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: `refresh-${token}`, expiresAt: 9999999999999 } });
async function account(store: AuthStore, identity: string, token: string) {
  const account = store.prepareWorker("claude");
  await prepareAccountProfile(store.stateDir, account, fileOnly);
  const root = claudeConfigRoot(store.stateDir, account.id);
  await writeFile(join(root, ".credentials.json"), creds(token), { mode: 0o600 });
  await writeFile(join(root, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: identity } }), { mode: 0o600 });
  const evidence = await credentialEvidence(store.stateDir, account, fileOnly);
  return store.confirmWorker(account.id, evidence.digest, evidence.identity);
}

test("Claude usage projects binding/scoped windows and provider-unit extra usage", () => {
  const usage = parseClaudeUsage(body());
  assert.deepEqual(usage, { windows: [
    { id: "five_hour", label: "5h", usedPercent: 24, remainingPercent: 76, resetsAt: "2026-09-25T15:00:00.000Z" },
    { id: "seven_day", label: "Weekly", usedPercent: 17, remainingPercent: 83, resetsAt: "2026-09-30T00:00:00.000Z" },
    { id: "seven_day_sonnet", label: "Weekly sonnet", usedPercent: 125, remainingPercent: 0, resetsAt: null },
  ], extraUsage: { enabled: true, monthlyLimit: 5000, usedCredits: 1225.5, utilization: 24.51 } });
  assert.deepEqual(claudeUsage.parse(usage), usage);
  assert.equal(JSON.stringify(usage).includes("must-not-publish"), false);
  assert.equal(parseClaudeUsage({ ...body(), extra_usage: null }).extraUsage, null);
  assert.deepEqual(parseClaudeUsage({ ...body(), extra_usage: { is_enabled: false } }).extraUsage,
    { enabled: false, monthlyLimit: null, usedCredits: null, utilization: null });
  assert.equal(parseClaudeUsage({ ...body(), five_hour: { utilization: 0, resets_at: "2026-09-25T15:00:00" } }).windows[0]?.resetsAt, null);
  for (const value of [
    {}, { ...body(), five_hour: null }, { ...body(), seven_day: {} },
    { ...body(), seven_day_sonnet: { utilization: -1 } }, { ...body(), seven_day_new_model: { utilization: "99" } },
    { ...body(), five_hour: { utilization: Infinity } }, { ...body(), extra_usage: "private-upstream-text" },
    { ...body(), extra_usage: { used_credits: -1 } },
  ]) assert.throws(() => parseClaudeUsage(value), /response_invalid/);
});

test("Claude read-only collection pins account identity, token source, endpoint and OAuth headers", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-claude-usage-"));
  const store = new AuthStore(root);
  try {
    const a = await account(store, "10000000-0000-4000-8000-000000000001", "first-secret");
    const b = await account(store, "10000000-0000-4000-8000-000000000002", "second-secret");
    const before = await readFile(join(claudeConfigRoot(root, a.id), ".credentials.json"));
    const seen: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      assert.equal(String(input), "https://api.anthropic.com/api/oauth/usage");
      assert.equal(init?.method, undefined);
      assert.equal(init?.redirect, "manual");
      assert.ok(init?.signal);
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers["anthropic-beta"], "oauth-2025-04-20");
      assert.equal(headers["anthropic-version"], "2023-06-01");
      seen.push(headers.authorization!);
      return Response.json(body(headers.authorization === "Bearer first-secret" ? 24 : 80));
    };
    const first = claudeUsage.parse(await collectAccount(root, a.id, "claude", fetcher, undefined, "worker", fileOnly));
    const second = claudeUsage.parse(await collectAccount(root, b.id, "claude", fetcher, undefined, "worker", fileOnly));
    assert.deepEqual(seen, ["Bearer first-secret", "Bearer second-secret"]);
    assert.equal(first.windows[0]?.usedPercent, 24);
    assert.equal(second.windows[0]?.usedPercent, 80);
    assert.deepEqual(await readFile(join(claudeConfigRoot(root, a.id), ".credentials.json")), before);
    await assert.rejects(collectAccount(root, a.id, "claude", fetcher, undefined, "bot", fileOnly), /account_invalid/);
    await writeFile(join(claudeConfigRoot(root, a.id), ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "10000000-0000-4000-8000-000000000002" } }));
    await assert.rejects(collectAccount(root, a.id, "claude", fetcher, undefined, "worker", fileOnly), /identity_invalid/);
    assert.equal(seen.length, 2);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("Claude usage reads only the exact injected keychain service and sanitizes bounded HTTP failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-claude-usage-keychain-"));
  const store = new AuthStore(root);
  try {
    const a = await account(store, "10000000-0000-4000-8000-000000000001", "file-secret");
    const calls: string[][] = [];
    const options = { platform: "darwin" as const, security: async (args: string[]) => { calls.push(args); return { code: 0, stdout: creds("keychain-secret") }; } };
    const observe = (fetcher: typeof fetch) => collectAccount(root, a.id, "claude", fetcher, undefined, "worker", options);
    await observe(async (_input, init) => {
      assert.equal((init?.headers as Record<string, string>).authorization, "Bearer keychain-secret");
      return Response.json(body());
    });
    assert.deepEqual(calls[0]?.slice(0, 3), ["find-generic-password", "-s", claudeKeychainService(claudeConfigRoot(root, a.id))]);
    for (const [status, code] of [[401, "auth_unavailable"], [429, "rate_limited"], [500, "provider_error"], [302, "provider_error"]] as const) {
      await assert.rejects(observe(async () => new Response("private-provider-body", { status })), { message: code });
    }
    await assert.rejects(observe(async () => { throw new Error("private-keychain-secret"); }), { message: "provider_unavailable" });
    await assert.rejects(observe(async () => new Response("private-json-secret")), { message: "response_invalid" });
    await assert.rejects(observe(async () => new Response("x".repeat(262_145))), { message: "response_invalid" });
    assert.ok(calls.every((args) => args[0] === "find-generic-password" && args[2] === calls[0]![2]));
    assert.equal((await readFile(join(claudeConfigRoot(root, a.id), ".credentials.json"), "utf8")).includes("file-secret"), true);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("Claude observer keeps account-scoped last-good usage through failures and reload, and prunes removal", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-claude-last-good-"));
  const store = new AuthStore(root);
  try {
    const a = await account(store, "10000000-0000-4000-8000-000000000001", "first-secret");
    const b = await account(store, "10000000-0000-4000-8000-000000000002", "second-secret");
    store.enableWorker(b.id, false);
    let fail = false;
    const observer = new UsageObserver(root, {}, async () => store.workerAccounts().map((account) => ({ ...account, scope: "worker" as const })),
      (id) => collectAccount(root, id, "claude", async () => id === a.id && fail ? Response.json({ five_hour: {} }) : Response.json(body(id === a.id ? 24 : 80)), undefined, "worker", fileOnly),
      async () => null);
    await observer.cycle();
    const before = observer.snapshot();
    assert.deepEqual(snapshotSchema.parse(before), before);
    assert.equal(before.accounts[1]?.enabled, false);
    assert.equal(before.accounts[1]?.fresh, true);
    fail = true;
    await observer.cycle(Date.now() + 181_000);
    const after = observer.snapshot();
    assert.equal(after.accounts[0]?.error, "response_invalid");
    assert.equal(after.accounts[0]?.fresh, false);
    assert.deepEqual(after.accounts[0]?.usage, before.accounts[0]?.usage);
    assert.equal(after.accounts[0]?.observedAtMs, before.accounts[0]?.observedAtMs);
    assert.equal(after.accounts[1]?.fresh, true);
    const persisted = await readFile(join(root, "usage", "observations.json"), "utf8");
    for (const secret of ["first-secret", "second-secret", "refresh-", "10000000-0000-4000-8000-000000000001"]) assert.equal(persisted.includes(secret), false);
    const restored = new UsageObserver(root, {}, async () => [], async () => null, async () => null);
    await restored.load();
    assert.deepEqual(restored.snapshot().accounts.map((row) => row.usage), after.accounts.map((row) => row.usage));
    assert.equal(restored.snapshot().accounts[0]?.fresh, false);
    store.beginWorkerRemoval(a.id);
    await observer.cycle();
    assert.deepEqual(observer.snapshot().accounts.map((row) => row.id), [b.id]);
    await restored.close();
    await observer.close();
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
