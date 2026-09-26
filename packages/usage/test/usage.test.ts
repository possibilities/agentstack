import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { accountSignIn, collectAccount, collectGrokBot } from "../src/collect.js";
import { UsageObserver } from "../src/observer.js";
import { grokUsage, snapshotSchema, type Provider } from "../src/schema.js";

const codexId = "00000000-0000-4000-8000-000000000001";
const grokId = "00000000-0000-4000-8000-000000000002";
const devinId = "00000000-0000-4000-8000-000000000003";
const ids: Partial<Record<Provider, string>> = { codex: codexId, grok: grokId, devin: devinId };

test("observes each registered account with its own credentials and projects only usage", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-usage-"));
  try {
    const secrets = join(root, "secrets.sqlite");
    const db = new DatabaseSync(secrets);
    db.exec("CREATE TABLE credentials (name TEXT, auth_json TEXT)");
    db.prepare("INSERT INTO credentials VALUES (?, ?)").run(codexId, JSON.stringify({ tokens: {
      access_token: "codex-secret", account_id: "native-codex", refresh_token: "never-publish",
      id_token: `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "native-codex",
        chatgpt_subscription_active_until: "2026-09-30T15:22:09+00:00", chatgpt_subscription_last_checked: "2026-09-26T01:27:38.866955+00:00" } })).toString("base64url")}.sig`,
    } }));
    db.close();
    await chmod(secrets, 0o600);
    await mkdir(join(root, "worker-accounts", codexId, "data/opencode"), { recursive: true });
    const codexWorkerDb = new DatabaseSync(join(root, "worker-accounts", codexId, "data/opencode/opencode.db"));
    codexWorkerDb.exec("CREATE TABLE credential (integration_id TEXT, value TEXT)");
    codexWorkerDb.prepare("INSERT INTO credential VALUES (?, ?)").run("openai", JSON.stringify({ type: "oauth", access: "codex-worker-secret", refresh: "never-publish", metadata: { accountID: "native-worker" } }));
    codexWorkerDb.close();
    await chmod(join(root, "worker-accounts", codexId, "data/opencode/opencode.db"), 0o600);
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
        const headers = init?.headers as Record<string, string>;
        const worker = headers.authorization === "Bearer codex-worker-secret";
        assert.equal(headers["ChatGPT-Account-ID"], worker ? "native-worker" : "native-codex");
        return Response.json({ plan_type: "pro", rate_limit: { primary_window: { used_percent: worker ? 34 : 12, limit_window_seconds: 18000, reset_after_seconds: 200 } },
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
        planEnd: "2026-10-23T02:47:53Z", planInfo: { planName: "Pro", billingStrategy: "BILLING_STRATEGY_QUOTA", monthlyPromptCredits: 100 } } } });
    };
    const results = await Promise.all((["codex", "grok", "devin"] as const).map((provider) => collectAccount(root, ids[provider]!, provider, fetcher)));
    const workerUsage = await collectAccount(root, codexId, "codex", fetcher, undefined, "worker");
    assert.equal((results[0] as { lanes: Array<{ windows: Array<{ usedPercent: number }> }> }).lanes[0]?.windows[0]?.usedPercent, 12);
    assert.equal((workerUsage as { lanes: Array<{ windows: Array<{ usedPercent: number }> }> }).lanes[0]?.windows[0]?.usedPercent, 34);
    assert.deepEqual(await accountSignIn(root, codexId, "codex", "worker"), { identity: "native-worker", subscription: null });
    assert.deepEqual(await accountSignIn(root, codexId, "codex", "bot"), { identity: "native-codex",
      subscription: { endsAt: "2026-09-30T15:22:09.000Z", source: "sign_in_claim", checkedAtMs: Date.parse("2026-09-26T01:27:38.866Z") } });
    assert.equal((results[1] as { prepaidBalanceUsd: number }).prepaidBalanceUsd, 2.5);
    assert.equal((results[1] as { included: { allocatedUsd: number | null } }).included.allocatedUsd, null);
    assert.equal((results[2] as { dailyRemainingPercent: number }).dailyRemainingPercent, 76);
    assert.equal((results[2] as { periodEnd: string | null }).periodEnd, "2026-10-23T02:47:53.000Z");
    assert.equal(seen.length, 5);
    assert.ok(!JSON.stringify(results).includes("secret"));
    assert.ok(!JSON.stringify(results).includes("native-codex"));
    const path = join(root, "worker-accounts", devinId, "data/devin/credentials.toml");
    await rm(path);
    await symlink(secrets, path);
    await assert.rejects(collectAccount(root, devinId, "devin", fetcher), /credentials_unavailable/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Grok includes a provider-declared monthly dollar allocation without guessing one from percentages", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-usage-credits-"));
  try {
    await mkdir(join(root, "worker-accounts", grokId, "data/opencode"), { recursive: true });
    const db = new DatabaseSync(join(root, "worker-accounts", grokId, "data/opencode/opencode.db"));
    db.exec("CREATE TABLE credential (integration_id TEXT, value TEXT)");
    db.prepare("INSERT INTO credential VALUES (?, ?)").run("xai", JSON.stringify({ type: "oauth", access: "grok-secret" }));
    db.close();
    await chmod(join(root, "worker-accounts", grokId, "data/opencode/opencode.db"), 0o600);
    const observe = async (monthlyLimit: unknown) => collectAccount(root, grokId, "grok", async (input) =>
      String(input).endsWith("/userinfo") ? Response.json({ sub: "grok-user" }) : Response.json({
        config: { monthlyLimit, used: { val: "500" }, prepaidBalance: { val: "125" } },
      }));
    const allocated = grokUsage.parse(await observe({ val: "2000" }));
    assert.deepEqual(allocated.included, { usedPercent: 25, remainingPercent: 75, periodType: null,
      periodStart: null, resetsAt: null, allocatedUsd: 20 });
    assert.equal(allocated.prepaidBalanceUsd, 1.25);
    assert.equal(grokUsage.parse(await observe({})).included.allocatedUsd, 0);
    assert.equal(grokUsage.parse(await observe({ unexpected: 20 })).included.allocatedUsd, null);
    assert.equal(grokUsage.parse(await observe({ val: "-1" })).included.allocatedUsd, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("owner observer keeps last-good records, removes deleted accounts and paces retries", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-usage-"));
  try {
    let available = true, successes = true, calls = 0, changes = 0;
    const observer = new UsageObserver(root, {}, async () => available ? [{ id: codexId, scope: "bot", provider: "codex", enabled: true, ready: true, removing: false },
      { id: grokId, scope: "worker", provider: "grok", enabled: false, ready: true, removing: false }] : [],
      async (_id, provider) => { calls++; if (!successes) throw new Error("provider echoed private credentials");
        return provider === "codex" ? { planType: "pro", limitReached: false, resetCreditsAvailable: null, resetCreditExpirations: null, lanes: [] } : {
          subscriptionTier: null, included: { usedPercent: 10, remainingPercent: 90, periodType: null, periodStart: null, resetsAt: null, allocatedUsd: null },
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

test("usage links independent Bot and Worker Codex accounts by native identity without publishing it", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-usage-links-"));
  const codexWorkerId = "00000000-0000-4000-8000-000000000004";
  let workerReady = true;
  const accounts = async () => [
    { id: codexId, scope: "bot" as const, provider: "codex" as const, enabled: true, ready: true, removing: false },
    { id: codexWorkerId, scope: "worker" as const, provider: "codex" as const, enabled: true, ready: workerReady, removing: false },
  ];
  const observer = new UsageObserver(root, {}, accounts,
    async () => ({ planType: "pro", limitReached: false, resetCreditsAvailable: null, resetCreditExpirations: null, lanes: [] }),
    async () => null, async (_id, _provider, scope) => ({ identity: "native-account-never-published",
      subscription: scope === "bot" ? { endsAt: "2026-09-30T15:22:09.000Z", source: "sign_in_claim", checkedAtMs: 1 } : null }));
  try {
    await observer.cycle();
    const rows = observer.snapshot().accounts;
    assert.deepEqual(rows.map(({ scope, linkedAccounts }) => ({ scope, linkedAccounts })), [
      { scope: "bot", linkedAccounts: [{ scope: "worker", id: codexWorkerId }] },
      { scope: "worker", linkedAccounts: [{ scope: "bot", id: codexId }] },
    ]);
    // The claim is account-level evidence, so linked measurements stay equal.
    assert.deepEqual(rows.map((row) => row.subscription?.endsAt ?? null), ["2026-09-30T15:22:09.000Z", null]);
    assert.deepEqual(rows[0]?.usage, rows[1]?.usage);
    const snapshot = observer.snapshot();
    assert.deepEqual(snapshotSchema.parse(snapshot), snapshot);
    assert.equal(JSON.stringify(snapshot).includes("native-account-never-published"), false);
    assert.equal((await readFile(join(root, "usage/observations.json"), "utf8")).includes("native-account-never-published"), false);
    workerReady = false;
    await observer.cycle();
    assert.deepEqual(observer.snapshot().accounts.map((row) => row.linkedAccounts), [[], []]);
  } finally { await observer.close(); await rm(root, { recursive: true, force: true }); }
});

test("an auth account change re-reads the inventory without waiting for the next observation", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-usage-invalidate-"));
  let removed = false;
  let notify: () => void = () => undefined;
  let closeWatch: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => { closeWatch = resolve; });
  const observer = new UsageObserver(root, {}, async () => [
    { id: codexId, scope: "bot", provider: "codex", enabled: true, ready: true, removing: false },
    { id: grokId, scope: "worker", provider: "grok", enabled: true, ready: true, removing: removed },
  ], async () => null, async () => null, async () => null,
  async (onChange) => { notify = onChange; return { topics: ["accounts_changed", "worker_accounts_changed"], closed, close: async () => closeWatch() }; });
  const changed = () => new Promise<void>((resolve) => { observer.onChange = resolve; });
  try {
    const first = changed();
    observer.start();
    await first;
    assert.equal(observer.snapshot().accounts.length, 2);
    removed = true;
    const pruned = changed();
    notify();
    await pruned;
    assert.deepEqual(observer.snapshot().accounts.map((row) => row.id), [codexId]);
  } finally { await observer.close(); await rm(root, { recursive: true, force: true }); }
});

test("a legacy shared UUID remains two scoped usage records and two independent links", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-usage-overlap-"));
  const observer = new UsageObserver(root, {}, async () => [
    { id: codexId, scope: "bot", provider: "codex", enabled: true, ready: true, removing: false },
    { id: codexId, scope: "worker", provider: "codex", enabled: true, ready: true, removing: false },
  ], async (_id, _provider, scope) => ({ planType: scope, limitReached: false, resetCreditsAvailable: null, resetCreditExpirations: null, lanes: [] }),
  async () => null, async () => ({ identity: "same-private-identity", subscription: null }));
  try {
    await observer.cycle();
    const rows = observer.snapshot().accounts;
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => ({ scope: row.scope, linkedAccounts: row.linkedAccounts })), [
      { scope: "bot", linkedAccounts: [{ scope: "worker", id: codexId }] },
      { scope: "worker", linkedAccounts: [{ scope: "bot", id: codexId }] },
    ]);
    assert.equal(rows[0]?.provider === "codex" ? rows[0].usage?.planType : null, "bot");
    assert.equal(rows[1]?.provider === "codex" ? rows[1].usage?.planType : null, "worker");
    const restored = new UsageObserver(root, {}, async () => [], async () => null, async () => null);
    await restored.load();
    assert.equal(restored.snapshot().accounts.length, 2);
    assert.deepEqual(restored.snapshot().accounts.map((row) => row.linkedAccounts), [[], []]); // No persisted identities.
  } finally { await observer.close(); await rm(root, { recursive: true, force: true }); }
});

test("version-one usage rows migrate as Bot Codex and Worker Grok/Devin", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-usage-migrate-"));
  const path = join(root, "usage/observations.json");
  await mkdir(join(root, "usage"));
  const empty = { observedAtMs: null, lastAttemptAtMs: null, error: null, usage: null };
  await writeFile(path, JSON.stringify({ schemaVersion: 1, accounts: [
    { id: codexId, provider: "codex", enabled: true, ready: false, measurement: empty, nextAttemptAtMs: 0 },
    { id: grokId, provider: "grok", enabled: true, ready: false, measurement: empty, nextAttemptAtMs: 0 },
  ], bot: empty }), { mode: 0o600 });
  const observer = new UsageObserver(root, {}, async () => [
    { id: codexId, scope: "bot", provider: "codex", enabled: true, ready: true, removing: false },
    { id: grokId, scope: "worker", provider: "grok", enabled: true, ready: false, removing: false },
  ], async () => null, async () => null);
  try {
    await observer.load();
    assert.deepEqual(observer.snapshot().accounts.map((row) => row.scope), ["bot", "worker"]);
    await observer.cycle();
    const persisted = JSON.parse(await readFile(path, "utf8")) as { schemaVersion: number; accounts: Array<{ scope: string }> };
    assert.equal(persisted.schemaVersion, 3);
    assert.deepEqual(persisted.accounts.map((row) => row.scope), ["bot", "worker"]);
  } finally { await observer.close(); await rm(root, { recursive: true, force: true }); }
});

test("version-two Grok last-good usage survives the new dollar allocation field", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-usage-migrate-"));
  const path = join(root, "usage/observations.json");
  try {
    await mkdir(join(root, "usage"));
    const usage = { subscriptionTier: null, included: { usedPercent: 25, remainingPercent: 75,
      periodType: null, periodStart: null, resetsAt: null }, prepaidBalanceUsd: 1.25, paygEnabled: false,
      paygUsedUsd: null, paygCapUsd: null, paygRemainingUsd: null };
    await writeFile(path, JSON.stringify({ schemaVersion: 2, accounts: [{ id: grokId, scope: "worker",
      provider: "grok", enabled: true, ready: true, measurement: {
        observedAtMs: Date.now(), lastAttemptAtMs: Date.now(), error: null, usage }, nextAttemptAtMs: Date.now() + 180_000,
    }], bot: { observedAtMs: null, lastAttemptAtMs: null, error: null, usage: null } }), { mode: 0o600 });
    const observer = new UsageObserver(root, {}, async () => [{ id: grokId, scope: "worker", provider: "grok",
      enabled: true, ready: true, removing: false }], async () => { throw new Error("should not fetch"); }, async () => null);
    await observer.load();
    const [row] = observer.snapshot().accounts;
    assert.equal(row?.provider === "grok" ? row.usage?.included.allocatedUsd : undefined, null);
    assert.equal(row?.provider === "grok" ? row.usage?.prepaidBalanceUsd : undefined, 1.25);
    await observer.cycle();
    assert.equal(JSON.parse(await readFile(path, "utf8")).schemaVersion, 3);
    await observer.close();
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

test("a Devin plan period end is its subscription end, checked when measured", async () => {
  const root = await mkdtemp(join(tmpdir(), "agentstack-usage-devin-subscription-"));
  const usage = { planLabel: "Pro", billing: "quota", dailyRemainingPercent: 76, weeklyRemainingPercent: 54, dailyResetsAt: null,
    weeklyResetsAt: null, periodStart: "2026-09-23T02:47:53.000Z", periodEnd: "2026-10-23T02:47:53.000Z", promptCreditsMonthly: null,
    promptCreditsAvailable: null, weeklyQuotaHidden: null, displayName: null };
  const observer = new UsageObserver(root, {}, async () => [{ id: devinId, scope: "worker", provider: "devin", enabled: true, ready: true, removing: false }],
    async () => usage, async () => null, async () => null);
  try {
    await observer.cycle();
    const [row] = observer.snapshot().accounts;
    assert.deepEqual(row?.subscription, { endsAt: "2026-10-23T02:47:53.000Z", source: "plan_period", checkedAtMs: row?.observedAtMs });
    const restored = new UsageObserver(root, {}, async () => [], async () => null, async () => null);
    await restored.load();
    assert.deepEqual(restored.snapshot().accounts[0]?.subscription, row?.subscription);
  } finally { await observer.close(); await rm(root, { recursive: true, force: true }); }
});
