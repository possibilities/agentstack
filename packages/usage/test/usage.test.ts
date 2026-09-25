import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { collectAccount, collectGrokBot } from "../src/collect.js";
import { UsageObserver } from "../src/observer.js";
import { snapshotSchema, type Provider } from "../src/schema.js";

const codexId = "00000000-0000-4000-8000-000000000001";
const grokId = "00000000-0000-4000-8000-000000000002";
const devinId = "00000000-0000-4000-8000-000000000003";
const ids: Record<Provider, string> = { codex: codexId, grok: grokId, devin: devinId };

test("observes each registered account with its own credentials and projects only usage", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-usage-"));
  try {
    const secrets = join(root, "secrets.sqlite");
    const db = new DatabaseSync(secrets);
    db.exec("CREATE TABLE credentials (name TEXT, auth_json TEXT)");
    db.prepare("INSERT INTO credentials VALUES (?, ?)").run(codexId, JSON.stringify({ tokens: {
      access_token: "codex-secret", account_id: "native-codex", refresh_token: "never-publish",
    } }));
    db.close();
    await chmod(secrets, 0o600);
    for (const id of [grokId, devinId]) await mkdir(join(root, "worker-accounts", id, "data", id === grokId ? "opencode" : "devin"), { recursive: true });
    const grokDb = new DatabaseSync(join(root, "worker-accounts", grokId, "data/opencode/opencode.db"));
    grokDb.exec("CREATE TABLE credential (integration_id TEXT, value TEXT)");
    grokDb.prepare("INSERT INTO credential VALUES (?, ?)").run("xai", JSON.stringify({ type: "oauth", access: "grok-secret", refresh: "never-publish" }));
    grokDb.close();
    await chmod(join(root, "worker-accounts", grokId, "data/opencode/opencode.db"), 0o600);
    await writeFile(join(root, "worker-accounts", devinId, "data/devin/credentials.toml"),
      'windsurf_api_key = "devin-secret"\napi_server_url = "https://example.devin.ai"\n', { mode: 0o600 });
    const seen: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      seen.push(url);
      assert.notEqual((init?.headers as Record<string, string>)?.authorization, "Bearer never-publish");
      if (url.endsWith("/wham/usage")) {
        assert.equal((init?.headers as Record<string, string>)["ChatGPT-Account-ID"], "native-codex");
        return Response.json({ plan_type: "pro", rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_after_seconds: 200 } },
          additional_rate_limits: [{ limit_name: "Spark", rate_limit: { primary_window: { used_percent: 88 } } }] });
      }
      if (url.endsWith("/userinfo")) return Response.json({ sub: "grok-user" });
      if (url.includes("/billing?")) {
        assert.equal((init?.headers as Record<string, string>)["x-userid"], "grok-user");
        return Response.json({ config: { currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY", start: "2026-09-01", end: "2026-10-01" },
          isUnifiedBillingUser: true, prepaidBalance: { val: "250" }, onDemandCap: { val: "1000" }, onDemandUsed: { val: "125" } } });
      }
      assert.ok(url.endsWith("/GetUserStatus"));
      assert.equal(JSON.parse(String(init?.body)).metadata.apiKey, "devin-secret");
      return Response.json({ userStatus: { planStatus: { dailyQuotaRemainingPercent: 76, weeklyQuotaRemainingPercent: 54,
        planInfo: { planName: "Pro", billingStrategy: "BILLING_STRATEGY_QUOTA", monthlyPromptCredits: 100 } } } });
    };
    const results = await Promise.all((["codex", "grok", "devin"] as const).map((provider) => collectAccount(root, ids[provider], provider, fetcher)));
    assert.equal((results[0] as { lanes: Array<{ windows: Array<{ usedPercent: number }> }> }).lanes[0]?.windows[0]?.usedPercent, 12);
    assert.equal((results[1] as { prepaidBalanceUsd: number }).prepaidBalanceUsd, 2.5);
    assert.equal((results[2] as { dailyRemainingPercent: number }).dailyRemainingPercent, 76);
    assert.equal(seen.length, 4);
    assert.ok(!JSON.stringify(results).includes("secret"));
    assert.ok(!JSON.stringify(results).includes("native-codex"));
    const path = join(root, "worker-accounts", devinId, "data/devin/credentials.toml");
    await rm(path);
    await symlink(secrets, path);
    await assert.rejects(collectAccount(root, devinId, "devin", fetcher), /credentials_unavailable/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("owner observer keeps last-good records, removes deleted accounts and paces retries", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-usage-"));
  try {
    let available = true, successes = true, calls = 0, changes = 0;
    const observer = new UsageObserver(root, {}, async () => available ? [{ id: codexId, provider: "codex", enabled: true, ready: false, removing: false },
      { id: grokId, provider: "grok", enabled: false, ready: true, removing: false }] : [],
      async (_id, provider) => { calls++; if (!successes) throw new Error("provider echoed private credentials");
        return provider === "codex" ? { planType: "pro", limitReached: false, resetCreditsAvailable: null, resetCreditExpirations: null, lanes: [] } : {
          subscriptionTier: null, included: { usedPercent: 10, remainingPercent: 90, periodType: null, periodStart: null, resetsAt: null },
          prepaidBalanceUsd: null, paygEnabled: false, paygUsedUsd: null, paygCapUsd: null, paygRemainingUsd: null,
        }; },
      async () => null);
    observer.onChange = () => changes++;
    await observer.cycle();
    let snapshot = observer.snapshot();
    assert.deepEqual(snapshotSchema.parse(snapshot), snapshot);
    assert.equal(snapshot.accounts.length, 2);
    assert.equal(snapshot.accounts[0]?.fresh, true);
    assert.ok(snapshot.accounts[1]?.usage);
    assert.equal(snapshot.accounts[1]?.enabled, false);
    assert.equal(calls, 2);
    assert.equal(changes, 1);
    await observer.cycle();
    assert.equal(calls, 2);
    const restoredBeforeRemoval = new UsageObserver(root, {}, async () => [], async () => null, async () => null);
    await restoredBeforeRemoval.load();
    assert.equal(restoredBeforeRemoval.snapshot().accounts.length, 2);
    assert.equal(restoredBeforeRemoval.snapshot().accounts[0]?.fresh, false); // no verified inventory yet
    const persisted = await readFile(join(root, "usage/observations.json"), "utf8");
    assert.ok(!persisted.includes("provider echoed private credentials"));
    successes = false;
    await observer.cycle(Date.now() + 181_000);
    snapshot = observer.snapshot();
    assert.equal(snapshot.accounts[0]?.error, "observation_failed");
    assert.equal(snapshot.accounts[0]?.fresh, false);
    assert.ok(snapshot.accounts[0]?.usage);
    assert.equal(calls, 4);
    available = false;
    await observer.cycle();
    assert.equal(observer.snapshot().accounts.length, 0);
    await observer.close();
    const restored = new UsageObserver(root, {}, async () => [], async () => null, async () => null);
    await restored.load();
    assert.equal(restored.snapshot().accounts.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Grok Bot CLI output is bounded and its provider identifiers are never published", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-usage-"));
  try {
    const binary = join(root, "agentgrok");
    await writeFile(binary, `#!/usr/bin/env node
console.log(JSON.stringify({schema_version:1,ok:true,data:{usage:{usagePercent:42,currentPeriodStartMs:1780272000000,nextResetAtMs:1782864000000,hasAvailableUsage:true,planLabel:'Premium',fundingPlan:'annual',onDemandEligible:false,onDemandEnabled:false,trial:false,isTeamSeat:true,accountId:'secret-id'}}}));
`, { mode: 0o700 });
    const usage = await collectGrokBot(binary);
    assert.equal(usage.usedPercent, 42);
    assert.equal(usage.teamSeat, true);
    assert.equal(JSON.stringify(usage).includes("secret-id"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
